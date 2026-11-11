import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CreditCard, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import {
  balanceLabel,
  creditsLabel,
  dateLabel,
  getBilling,
  paymentNotice,
  rubLabel,
  updateAutoRenew,
  type BillingData,
  type PlanId,
  type PlanLimits,
} from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";
import { PlanDetail } from "./PlanDetail";
import { CreditTopUpDialog } from "./CreditTopUpDialog";
import { PaymentHistory } from "./PaymentHistory";
import { UsageOverview } from "./UsageOverview";

const faq = [
  { question: "Как оплатить тариф?", answer: "Откройте карточку тарифа, отметьте согласия и нажмите «Оплатить» — откроется защищённая страница оплаты. Доступны карта РФ, СБП и другие способы." },
  { question: "Когда включится тариф?", answer: "Сразу после подтверждения оплаты. Если страница оплаты закрылась, вернитесь в личный кабинет: подписка уже будет активна." },
  { question: "Что с продлением?", answer: "Подписка действует месяц. Пока оплаченный период не закончился, тот же тариф повторно оплатить нельзя: дата окончания не сдвигается. После окончания его можно оплатить снова. Автопродление — по отдельному согласию, отключить можно в любой момент." },
  { question: "Можно ли докупить кредиты?", answer: "Да, на «Плюсе» и «Премиуме». Откройте «Докупить кредиты», введите количество и оплатите разовый платёж — кредиты зачислятся сразу, не сгорят и расходуются после месячного лимита тарифа." },
];

const limitRows: Array<{ label: string; key: keyof PlanLimits }> = [
  { label: "Проектов одновременно", key: "projects" },
];
// Запуски и браузерные проверки — не отдельные шкалы тарифа: на платных тарифах расход
// ограничен кредитами, а браузерная проверка включается режимом на конкретный запуск. Поэтому
// в сравнении остаются только проекты, кредиты и цена.

/**
 * Separate page with the full description of every plan. It is a full-screen
 * view of the home experience: the home screen renders it instead of itself.
 */
export function SubscriptionPage({ onBack, selectedPlanId, onSelectPlan }: {
  onBack: () => void;
  selectedPlanId: PlanId | null;
  onSelectPlan: (plan: PlanId | null) => void;
}) {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingRenew, setSavingRenew] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [error, setError] = useState("");
  // The plan the user selected is what they want to move to, so it is named here too.
  const planChoice = usePlanChoice();

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setBilling(await getBilling()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // «Докупить кредиты» из боковой панели ведёт сразу к окну докупки, а не просто на тарифы.
  useEffect(() => {
    try {
      if (!localStorage.getItem("webnestdev.openCreditTopUp")) return;
      localStorage.removeItem("webnestdev.openCreditTopUp");
      setTopUpOpen(true);
    } catch {}
  }, []);

  // Действующий тариф — тот, что вернул сервер: выбор пользователя это пожелание, а не право.
  const currentPlanId = activePlanId(billing);
  const chosenId = chosenPlanId(planChoice);
  const chosenPending = isPendingChoice(planChoice, billing);
  const enabled = Boolean(billing?.paymentsEnabled);
  const subscription = billing?.subscription;
  const paid = currentPlanId !== "free" && Boolean(subscription?.renewsAt);
  const selectedPlan = selectedPlanId ? billing?.plans.find(plan => plan.id === selectedPlanId) : undefined;

  // Карточка открывает отдельный компактный экран: на нём описание, согласия и оплата.
  // Пока данные загружаются, страница не мигает обратно на общую сетку.
  if (selectedPlanId) {
    return <main className="subscription-page subscription-page-detail">
      <header className="subscription-top">
        <button className="ghost-button" onClick={() => onSelectPlan(null)}><ArrowLeft size={14}/> Все тарифы</button>
        <button className="ghost-button" onClick={onBack}>На главную</button>
      </header>
      {loading && <div className="modal-state plan-detail-loading"><RefreshCw size={14} className="spin"/> Загружаем тариф…</div>}
      {error && <div className="settings-error subscription-error">{error}</div>}
      {billing && selectedPlan && <div className="plan-detail-shell">
        <PlanDetail key={selectedPlan.id} plan={selectedPlan} billing={billing} active={selectedPlan.id === currentPlanId} onTopUp={() => setTopUpOpen(true)}/>
      </div>}
      {billing && !selectedPlan && <div className="plan-detail-shell plan-detail-missing">
        <p>Такого тарифа больше нет в каталоге.</p>
        <button className="ghost-button" onClick={() => onSelectPlan(null)}>Вернуться к тарифам</button>
      </div>}
      <CreditTopUpDialog open={topUpOpen} onClose={() => setTopUpOpen(false)} billing={billing} paid={paid}/>
    </main>;
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
      <span className="plan-pill">
        {enabled ? <><CreditCard size={12}/> ОПЛАТА КАРТОЙ И СБП</> : <><ShieldCheck size={12}/> ОПЛАТА СКОРО</>}
      </span>
    </header>

    <section className="subscription-hero">
      <span className="eyebrow">ТАРИФЫ NESTDEV</span>
      <h1>Тарифы и подписка</h1>
      <p>Три уровня доступа к агентной разработке: от знакомства до работы небольшой команды. Выберите карточку — откроется описание тарифа, согласия и оплата. На платных тарифах кредиты можно докупить любым количеством от {creditsLabel(billing?.creditTopUp?.minCredits ?? 1_000)}. {paymentNotice(billing)}</p>
      <div className="subscription-status">
        <div><span>Текущий тариф</span><strong>{billing?.plans.find(plan => plan.id === currentPlanId)?.name ?? "Старт"}</strong></div>
        <div><span>{paid ? "Оплачено до" : "Баланс"}</span><strong>{paid ? dateLabel(subscription?.renewsAt ?? null) : balanceLabel(billing?.balance)}</strong></div>
      </div>
      {paid && billing?.credits && billing.credits.limit > 0 && <button
        type="button"
        className="ghost-button subscription-credit-link"
        onClick={() => setTopUpOpen(true)}
      ><Plus size={12}/> Докупить кредиты</button>}
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
      {billing && chosenPending && <p className="account-muted subscription-status-text">{"Выбран тариф «" + planName(billing, chosenId) + "»" + (enabled ? " — его можно оплатить ниже." : " — включим его вместе с оплатой.")}</p>}
    </section>

    {loading && <div className="modal-state"><RefreshCw size={14} className="spin"/> Загружаем тарифы…</div>}
    {error && <div className="settings-error subscription-error">{error}</div>}

    {billing && <>
      <section className="subscription-plans" id="subscription-plans">
        {billing.plans.map(plan => {
          const active = plan.id === currentPlanId;
          const chosen = chosenPending && chosenId === plan.id;
          return <button
            type="button"
            key={plan.id}
            className={"subscription-plan" + (plan.recommended ? " recommended" : "") + (active ? " active" : "") + (chosen ? " chosen" : "")}
            onClick={() => onSelectPlan(plan.id)}
            aria-label={"Открыть описание тарифа «" + plan.name + "»"}
          >
            <div className="subscription-plan-head">
              {active
                ? <span className="plan-badge">Ваш тариф</span>
                : chosen
                  ? <span className="plan-badge">{enabled ? "Выбран" : "Выбран · оплата скоро"}</span>
                  : plan.recommended ? <span className="plan-badge">Популярный выбор</span> : null}
              <h2>{plan.name}</h2>
              <span className="plan-tagline">{plan.description}</span>
              <div className="plan-price">
                {Boolean(plan.discountPercent)&&<s className="plan-price-old">{plan.basePriceLabel}</s>}
                {plan.priceLabel}<small>{plan.id === "free" ? "навсегда" : (enabled ? "в месяц" : "оплата скоро")}</small>
              </div>
            </div>
            <ul className="plan-feature-list">{plan.features.slice(0, 3).map(feature => <li key={feature}><Check size={13}/>{feature}</li>)}</ul>
            <span className="subscription-plan-open">{active ? "Текущий тариф" : "Описание и оплата"} <ArrowRight size={13}/></span>
          </button>;
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
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>{plan.limits[row.key] ?? "Без ограничений"}</td>)}
              </tr>)}
              <tr>
                <th scope="row">Кредитов на агента в месяц</th>
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>
                  {plan.limits.agentCreditsPerMonth ? creditsLabel(plan.limits.agentCreditsPerMonth) : "по дневному лимиту"}
                </td>)}
              </tr>
              <tr>
                <th scope="row">Цена</th>
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>
                  {Boolean(plan.discountPercent) && <s className="plan-price-old">{plan.basePriceLabel}</s>}
                  {plan.priceLabel}{plan.id === "free" ? "" : " / мес"}
                </td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="subscription-usage">
        <UsageOverview billing={billing} paid={paid} onTopUp={() => setTopUpOpen(true)}/>
      </section>

      {Boolean(billing.payments?.length) && <section className="subscription-payments">
        <PaymentHistory payments={billing.payments ?? []}/>
      </section>}
    </>}

    <section className="subscription-faq">
      <div className="subscription-section-head"><span className="eyebrow">ВОПРОСЫ</span><h2>Частые вопросы</h2></div>
      <div className="faq-grid">{faq.map(item => <article key={item.question}><strong>{item.question}</strong><p>{item.answer}</p></article>)}</div>
    </section>    <section className="subscription-cta">
      <div><strong>{paid ? "Тариф и кредиты" : "Выберите тариф"}</strong><span>{paid ? "Повторно оплатить текущий тариф можно после окончания периода; кредиты доступны сейчас." : enabled ? "Оплата картой или через СБП на защищённой странице оплаты." : "Тариф сохранится и включится вместе с оплатой."}</span></div>
      <div className="subscription-cta-actions">
        <button className="ghost-button" onClick={onBack}>Вернуться на главную</button>
        <button className="send-button subscription-cta-button" onClick={() => document.getElementById("subscription-plans")?.scrollIntoView({ behavior: "smooth", block: "start" })}>К тарифам <ArrowRight size={13}/></button>
      </div>
    </section>

    {/* Условия оплаты — рядом с тарифами, а не только в оферте: именно здесь человек
        решает платить. */}
    <section className="subscription-legal">
      <div>
        <span className="eyebrow">УСЛОВИЯ</span>
        <h2>Оплата и документы</h2>
        <p>Карта РФ, СБП и другие способы — на защищённой странице оплаты. Подписка действует месяц; автопродление включается только по вашему согласию и отключается в один шаг в личном кабинете.</p>
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
