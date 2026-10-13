import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { getBilling, planDateLabel, subscriptionSummary, type BillingData, type PlanLimits } from "../../lib/billing-api";
import { chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

const faq = [
  { question: "Как включить тариф?", answer: "Выберите тариф и нажмите «Подтвердить» — в демо-режиме доступ открывается сразу на 30 дней, без оплаты." },
  { question: "Нужна ли банковская карта?", answer: "Нет. Оплата, карты и реальные списания в демо-режиме отключены — это сделано намеренно, пока мы готовим биллинг." },
  { question: "Что произойдёт через 30 дней?", answer: "Демо-подписка закончится сама, аккаунт вернётся на бесплатный тариф. Проекты, файлы и история сессий сохранятся." },
  { question: "Как отменить демо-подписку?", answer: "В рабочей области откройте «Настройки» → «Аккаунт и тариф» и нажмите «Отменить демо-подписку». Списаний не будет." },
];

function bytesLabel(value: number): string {
  if (value < 1024) return value + " Б";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " КБ";
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " МБ";
  return (value / 1024 / 1024 / 1024).toFixed(1) + " ГБ";
}

const limitRows: Array<{ label: string; key: keyof PlanLimits }> = [
  { label: "Проектов одновременно", key: "projects" },
  { label: "Запусков агента в день", key: "agentRunsPerDay" },
  { label: "Браузерных проверок в день", key: "browserChecksPerDay" },
];

/**
 * Separate page with the full description of every plan. It is a full-screen
 * view of the home experience: the home screen renders it instead of itself.
 */
export function SubscriptionPage({ onBack, onOpenPicker }: { onBack: () => void; onOpenPicker: () => void }) {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // The plan the user selected is the one that will be paid for, so it is named here too.
  const planChoice = usePlanChoice();

  useEffect(() => {
    let active = true;
    void getBilling()
      .then(data => { if (active) setBilling(data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const currentPlanId = billing?.subscription.plan;
  const demoActive = billing?.subscription.status === "demo_active";
  const chosenId = billing ? chosenPlanId(billing, planChoice) : null;
  const chosenPending = billing ? isPendingChoice(billing, planChoice) : false;

  return <main className="subscription-page">
    <header className="subscription-top">
      <button className="ghost-button" onClick={onBack}><ArrowLeft size={14}/> На главную</button>
      <button className="send-button" onClick={onOpenPicker}><Sparkles size={14}/> Выбрать тариф</button>
    </header>

    <section className="subscription-hero">
      <span className="eyebrow">ТАРИФЫ WEBNESTDEV</span>
      <h1>Тарифы и подписка</h1>
      <p>Три уровня доступа к агентной разработке: от знакомства до работы небольшой команды. Сейчас всё работает в демо-режиме — платить не нужно.</p>
      <div className="subscription-status">
        <div><span>Текущий тариф</span><strong>{billing?.plans.find(plan => plan.id === currentPlanId)?.name ?? "—"}</strong></div>
        <span className="demo-pill"><ShieldCheck size={12}/> ДЕМО-РЕЖИМ</span>
      </div>
      {billing && <p className="account-muted subscription-status-text">{subscriptionSummary(billing.subscription)}{chosenPending && chosenId ? " Выбран к оплате тариф «" + planName(billing, chosenId) + "»." : ""}</p>}
    </section>

    {loading && <div className="modal-state"><RefreshCw size={14} className="spin"/> Загружаем тарифы…</div>}
    {error && <div className="settings-error subscription-error">{error}</div>}

    {billing && <>
      <section className="subscription-plans">
        {billing.plans.map(plan => {
          const active = plan.id === billing.subscription.plan && demoActive;
          const chosen = chosenPending && chosenId === plan.id;
          return <article key={plan.id} className={"subscription-plan" + (plan.recommended ? " recommended" : "") + (active ? " active" : "") + (chosen ? " chosen" : "")}>
            <div className="subscription-plan-head">
              {chosen && <span className="plan-badge">Выбран · будет оплачен</span>}
              {!chosen && plan.recommended && <span className="plan-badge">Популярный выбор</span>}
              <h2>{plan.name}</h2>
              <span className="plan-tagline">{plan.tagline}</span>
              <div className="plan-price">{plan.priceLabel}<small>{plan.id === "free" ? "навсегда" : "демо на 30 дней"}</small></div>
            </div>
            <p className="plan-audience">{plan.audience}</p>
            <ul className="plan-feature-list">{plan.features.map(feature => <li key={feature}><Check size={13}/>{feature}</li>)}</ul>
            <ul className="plan-detail-list">{plan.details.map(detail => <li key={detail}>{detail}</li>)}</ul>
            <div className="subscription-plan-actions">
              {plan.id === "free"
                ? <span className="plan-current">{currentPlanId === "free" ? "Текущий тариф" : "Доступен всегда"}</span>
                : active
                  ? <span className="plan-current">Активен (демо до {planDateLabel(billing.subscription.expiresAt)})</span>
                  : <button className="plan-action" onClick={onOpenPicker}>Перейти на «{plan.name}»</button>}
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
                <th scope="row">Цена сейчас</th>
                {billing.plans.map(plan => <td key={plan.id} className={plan.id === currentPlanId ? "current" : ""}>{plan.priceLabel}</td>)}
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
          {(() => {
            const storageLimit = billing.limits.storageBytes ?? 0;
            const storageUsed = billing.storage?.usedBytes ?? 0;
            if (storageLimit <= 0) return null;
            return (
              <div className="usage-meter">
                <div><span>Хранилище аккаунта</span><strong>{bytesLabel(storageUsed)} из {bytesLabel(storageLimit)}</strong></div>
                <div className="usage-meter-track"><span style={{ width: `${Math.min(100, (storageUsed / storageLimit) * 100)}%` }} /></div>
              </div>
            );
          })()}
        </div>
      </section>
    </>}

    <section className="subscription-faq">
      <div className="subscription-section-head"><span className="eyebrow">ВОПРОСЫ</span><h2>Частые вопросы</h2></div>
      <div className="faq-grid">{faq.map(item => <article key={item.question}><strong>{item.question}</strong><p>{item.answer}</p></article>)}</div>
    </section>

    <section className="subscription-cta">
      <div><strong>Готовы включить тариф?</strong><span>Это займёт одну минуту. Оплата не потребуется.</span></div>
      <div className="subscription-cta-actions">
        <button className="ghost-button" onClick={onBack}>Вернуться на главную</button>
        <button className="send-button subscription-cta-button" onClick={onOpenPicker}>Выбрать тариф <ArrowRight size={13}/></button>
      </div>
    </section>

    <p className="billing-disclaimer">Демо-режим: платежи, банковские карты и реальные списания отключены. Тарифы и лимиты демонстрационные и могут измениться до запуска оплаты.</p>
  </main>;
}
