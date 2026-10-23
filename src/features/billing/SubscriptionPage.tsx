import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import {
  balanceLabel,
  bytesLabel,
  dateLabel,
  getBilling,
  paymentNotice,
  paymentStatusLabel,
  rubLabel,
  shortDayLabel,
  startCheckout,
  tokensLabel,
  updateAutoRenew,
  type BillingData,
  type PlanLimits,
} from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

const faq = [
  { question: "Как оплатить тариф?", answer: "Выберите тариф и нажмите «Оплатить» — откроется защищённая страница Робокассы. Карта РФ, СБП и другие способы доступны там же." },
  { question: "Когда включится тариф?", answer: "Сразу после подтверждения платежа Робокассой. Если страница оплаты закрылась, вернитесь в личный кабинет: подписка уже будет активна." },
  { question: "Что с продлением?", answer: "Подписка покупается на месяц. Автопродление включается в личном кабинете и работает, если платёжный сервис поддерживает периодические платежи; иначе тариф просто закончится в указанную дату. Отключить продление можно в любой момент." },
  { question: "Нужен ли чек?", answer: "Да, чек самозанятого формируется в «Моём налоге» и приходит покупателю. Робокасса передаёт данные об оплате в ФНС, если в кабинете подключены «Робочеки СМЗ»." },
];

const limitRows: Array<{ label: string; key: keyof PlanLimits }> = [
  { label: "Проектов одновременно", key: "projects" },
  { label: "Запусков агента в день", key: "agentRunsPerDay" },
  { label: "Браузерных проверок в день", key: "browserChecksPerDay" },
];
// Квоту поиска в интернете в сравнении тарифов не показываем: для человека это инструмент внутри
// запуска агента, а не отдельная шкала. Дневной лимит остаётся на сервере как защита от перерасхода.

/**
 * Separate page with the full description of every plan. It is a full-screen
 * view of the home experience: the home screen renders it instead of itself.
 */
export function SubscriptionPage({ onBack, onOpenPicker }: { onBack: () => void; onOpenPicker: () => void }) {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState<string | null>(null);
  const [savingRenew, setSavingRenew] = useState(false);
  const [error, setError] = useState("");
  // The plan the user selected is what they want to move to, so it is named here too.
  const planChoice = usePlanChoice();

  async function load() {
    setLoading(true); setError("");
    try { setBilling(await getBilling()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  // Действующий тариф — тот, что вернул сервер: выбор пользователя это пожелание, а не право.
  const currentPlanId = activePlanId(billing);
  const chosenId = chosenPlanId(planChoice);
  const chosenPending = isPendingChoice(planChoice, billing);
  const enabled = Boolean(billing?.paymentsEnabled);
  const subscription = billing?.subscription;
  const paid = currentPlanId !== "free" && Boolean(subscription?.renewsAt);

  async function pay(plan: "pro" | "team") {
    setPaying(plan); setError("");
    try {
      const checkout = await startCheckout(plan);
      window.location.assign(checkout.paymentUrl);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPaying(null); }
  }

  async function toggleRenew(autoRenew: boolean) {
    setSavingRenew(true); setError("");
    try { await updateAutoRenew(autoRenew); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSavingRenew(false); }
  }

  return <main className="subscription-page">
    <header className="subscription-top">
      <button className="ghost-button" onClick={onBack}><ArrowLeft size={14}/> На главную</button>
      <button className="send-button" onClick={onOpenPicker}><ShieldCheck size={14}/> Выбрать тариф</button>
    </header>

    <section className="subscription-hero">
      <span className="eyebrow">ТАРИФЫ NESTDEV</span>
      <h1>Тарифы и подписка</h1>
      <p>Три уровня доступа к агентной разработке: от знакомства до работы небольшой команды. {paymentNotice(billing)}</p>
      <div className="subscription-status">
        <div><span>Текущий тариф</span><strong>{billing?.plans.find(plan => plan.id === currentPlanId)?.name ?? "Старт"}</strong></div>
        <div><span>{paid ? "Оплачено до" : "Баланс"}</span><strong>{paid ? dateLabel(subscription?.renewsAt ?? null) : balanceLabel(billing?.balance)}</strong></div>
        <span className="plan-pill">
          {enabled ? <><CreditCard size={12}/> ОПЛАТА КАРТОЙ И СБП</> : <><ShieldCheck size={12}/> ОПЛАТА СКОРО</>}
        </span>
      </div>
      {paid && subscription && <div className="account-toggle subscription-renew">
        <span>
          <strong>Автопродление</strong>
          <small>{subscription.autoRenew
            ? "Включено: спишем " + rubLabel(subscription.amountRub) + " " + dateLabel(subscription.renewsAt) + ". Отключить можно в любой момент."
            : "Выключено: тариф закончится " + dateLabel(subscription.renewsAt) + " и сменится на бесплатный."}</small>
        </span>
        <span className="switch">
          <input
            type="checkbox"
            checked={subscription.autoRenew}
            disabled={savingRenew || (!subscription.autoRenew && !subscription.recurringAvailable)}
            onChange={event => void toggleRenew(event.target.checked)}
          />
          <span className="switch-track"><span className="switch-thumb"/></span>
        </span>
      </div>}
      {paid && subscription && !subscription.recurringAvailable && !subscription.autoRenew && <p className="account-muted subscription-status-text">Автопродление станет доступно после подключения услуги «Периодические платежи» в Робокассе.</p>}
      {billing && chosenPending && <p className="account-muted subscription-status-text">{"Выбран тариф «" + planName(billing, chosenId) + "»" + (enabled ? " — его можно оплатить ниже." : " — включим его вместе с оплатой.")}</p>}
    </section>

    {loading && <div className="modal-state"><RefreshCw size={14} className="spin"/> Загружаем тарифы…</div>}
    {error && <div className="settings-error subscription-error">{error}</div>}

    {billing && <>
      <section className="subscription-plans">
        {billing.plans.map(plan => {
          const active = plan.id === currentPlanId;
          const chosen = chosenPending && chosenId === plan.id;
          return <article key={plan.id} className={"subscription-plan" + (plan.recommended ? " recommended" : "") + (active ? " active" : "") + (chosen ? " chosen" : "")}>
            <div className="subscription-plan-head">
              {chosen && <span className="plan-badge">{enabled ? "Выбран" : "Выбран · оплата скоро"}</span>}
              {!chosen && plan.recommended && <span className="plan-badge">Популярный выбор</span>}
              <h2>{plan.name}</h2>
              <span className="plan-tagline">{plan.tagline}</span>
              <div className="plan-price">{plan.priceLabel}<small>{plan.id === "free" ? "навсегда" : (enabled ? "в месяц" : "оплата скоро")}</small></div>
            </div>
            <p className="plan-audience">{plan.audience}</p>
            <ul className="plan-feature-list">{plan.features.map(feature => <li key={feature}><Check size={13}/>{feature}</li>)}</ul>
            <ul className="plan-detail-list">{plan.details.map(detail => <li key={detail}>{detail}</li>)}</ul>
            <div className="subscription-plan-actions">
              {plan.id === "free"
                ? <span className="plan-current">{active ? "Текущий тариф" : "Входит всегда"}</span>
                : !enabled
                  ? <button className="plan-action" onClick={onOpenPicker}>{chosen ? "Выбран · изменить" : "Выбрать тариф"}</button>
                  : <button className="plan-action" disabled={paying !== null} onClick={() => void pay(plan.id as "pro" | "team")}>
                      {paying === plan.id ? <><RefreshCw size={12} className="spin"/> Открываем…</> : <>{active ? "Продлить" : "Оплатить"} {plan.priceLabel}</>}
                    </button>}
            </div>
          </article>;
        })}
      </section>

      <section className="subscription-compare">
        <div className="subscription-section-head"><span className="eyebrow">СРАВНЕНИЕ</span><h2>Лимиты тарифов</h2></div>
        <div className="compare-scroll">
          <table>
            <thead>
              <tr><th>Возможность</th>{billing.plans.map(plan => <th key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>{plan.name}</th>)}</tr>
            </thead>
            <tbody>
              {limitRows.map(row => <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>{plan.limits[row.key]}</td>)}
              </tr>)}
              <tr>
                <th scope="row">Токенов агента в месяц</th>
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>
                  {plan.limits.agentTokensPerMonth ? tokensLabel(plan.limits.agentTokensPerMonth) : "по дневному лимиту"}
                </td>)}
              </tr>
              <tr>
                <th scope="row">Цена</th>
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>{plan.priceLabel}{plan.id === "free" ? "" : " / мес"}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="subscription-usage">
        <div className="subscription-section-head"><span className="eyebrow">СЕГОДНЯ</span><h2>Использование</h2></div>
        <div className="usage-meter-list">
          <div className="usage-meter-title"><strong>Текущий день</strong><small>Сброс по UTC · {billing.usage.date}</small></div>
          <div className="usage-meter"><div><span>Запуски агента</span><strong>{billing.usage.agentRuns} / {billing.limits.agentRunsPerDay}</strong></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, billing.usage.agentRuns / Math.max(1, billing.limits.agentRunsPerDay) * 100)}%` }}/></div></div>
          <div className="usage-meter"><div><span>Браузерные проверки</span><strong>{billing.usage.browserChecks} / {billing.limits.browserChecksPerDay}</strong></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, billing.usage.browserChecks / Math.max(1, billing.limits.browserChecksPerDay) * 100)}%` }}/></div></div>
          {/* Пул токенов — основной лимит платного тарифа и месячный, а не дневной: он живёт
              отдельной шкалой, иначе его сброс путают с полуночью по UTC. */}
          {(() => {
            const budget = billing.tokens;
            if (!budget || budget.limit <= 0) return null;
            const state = budget.remaining <= 0 ? "full" : budget.used >= budget.limit * 0.8 ? "warning" : "ok";
            return (
              <div className={"usage-meter" + (state === "ok" ? "" : " is-" + state)}>
                <div><span>Токены агента в месяц</span><strong>{tokensLabel(budget.used)} из {tokensLabel(budget.limit)}</strong></div>
                <div className="usage-meter-track"><span style={{ width: `${Math.min(100, (budget.used / budget.limit) * 100)}%` }} /></div>
                <small className={"usage-meter-left" + (state === "ok" ? "" : " " + state)}>{state === "full"
                  ? "Пул исчерпан: встроенная модель недоступна до 1-го числа"
                  : "Осталось " + tokensLabel(budget.remaining) + " · сброс 1-го числа"}</small>
              </div>
            );
          })()}
          {(() => {
            const storageLimit = billing.limits.storageBytes ?? 0;
            const storageUsed = billing.storage?.usedBytes ?? 0;
            if (storageLimit <= 0) return null;
            const state = billing.storage?.state ?? (storageUsed >= storageLimit ? "full" : storageUsed >= storageLimit * 0.8 ? "warning" : "ok");
            return (
              <div className={"usage-meter" + (state === "ok" ? "" : " is-" + state)}>
                <div><span>Хранилище аккаунта</span><strong>{bytesLabel(storageUsed)} из {bytesLabel(storageLimit)}</strong></div>
                <div className="usage-meter-track"><span style={{ width: `${Math.min(100, (storageUsed / storageLimit) * 100)}%` }} /></div>
                {state !== "ok" && <small className={"usage-meter-left " + state}>{state === "full"
                  ? "Лимит исчерпан: запись файлов агентом приостановлена"
                  : "Осталось " + bytesLabel(Math.max(0, storageLimit - storageUsed))}</small>}
              </div>
            );
          })()}
        </div>
        <p className="account-muted">Запуски и токены считаются только для встроенной модели платформы. Подключите свой AI-провайдер в настройках проекта — запуски пойдут через ваш ключ и модель, и ни дневная квота, ни пул токенов к ним не применяются.</p>
      </section>

      {Boolean(billing.payments?.length) && <section className="subscription-compare">
        <div className="subscription-section-head"><span className="eyebrow">ПЛАТЕЖИ</span><h2>Последние платежи</h2></div>
        <div className="billing-payments">
          {(billing.payments ?? []).slice(0, 6).map(payment => <div className="billing-payment" key={payment.invId}>
            <div><strong>{payment.planName} · {rubLabel(payment.amount)}</strong><small>Счёт №{payment.invId} · {shortDayLabel(payment.createdAt.slice(0, 10))}</small></div>
            <span className={"billing-payment-status " + payment.status}>{paymentStatusLabel(payment.status)}</span>
          </div>)}
        </div>
      </section>}
    </>}

    <section className="subscription-faq">
      <div className="subscription-section-head"><span className="eyebrow">ВОПРОСЫ</span><h2>Частые вопросы</h2></div>
      <div className="faq-grid">{faq.map(item => <article key={item.question}><strong>{item.question}</strong><p>{item.answer}</p></article>)}</div>
    </section>

    <section className="subscription-cta">
      <div><strong>{paid ? "Продлить подписку" : "Выберите тариф"}</strong><span>{enabled ? "Оплата картой или через СБП на странице Робокассы." : "Тариф сохранится и включится вместе с оплатой."}</span></div>
      <div className="subscription-cta-actions">
        <button className="ghost-button" onClick={onBack}>Вернуться на главную</button>
        <button className="send-button subscription-cta-button" onClick={onOpenPicker}>Выбрать тариф <ArrowRight size={13}/></button>
      </div>
    </section>

    {/* Условия оплаты и возврата — рядом с тарифами, а не только в оферте: именно здесь
        человек решает платить. */}
    <section className="subscription-legal">
      <div>
        <span className="eyebrow">УСЛОВИЯ</span>
        <h2>Оплата, возврат и документы</h2>
        <p>Подписка оплачивается через Робокассу: картой или через СБП. Чек приходит на e-mail или телефон. Возврат за неиспользованный период — по заявлению на контактный e-mail в течение 10 календарных дней.</p>
      </div>
      <nav aria-label="Юридические документы">
        <a href="/legal/offer" target="_blank" rel="noopener noreferrer">Публичная оферта <ArrowRight size={12}/></a>
        <a href="/legal/payments" target="_blank" rel="noopener noreferrer">Оплата, подписка и возврат <ArrowRight size={12}/></a>
        <a href="/legal/terms" target="_blank" rel="noopener noreferrer">Пользовательское соглашение <ArrowRight size={12}/></a>
        <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Политика обработки данных <ArrowRight size={12}/></a>
        <a href="/legal/contacts" target="_blank" rel="noopener noreferrer">Реквизиты и контакты <ArrowRight size={12}/></a>
      </nav>
    </section>

    <p className="billing-disclaimer">{paymentNotice(billing)}</p>
  </main>;
}
