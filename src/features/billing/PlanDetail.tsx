import { useState } from "react";
import { Check, CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import {
  dateLabel,
  paymentNotice,
  startCheckout,
  type BillingData,
  type Plan,
} from "../../lib/billing-api";
import { writePlanChoice } from "../../lib/plan-choice";
import { CheckoutConsent, type CheckoutConsentState } from "./CheckoutConsent";

/**
 * Компактный экран одного тарифа. Согласия и кнопка оплаты стоят внизу, сразу под
 * описанием: на обзорной сетке их больше нет, поэтому человек не ищет галочки между
 * карточками. Сумма и ссылка на оплату по-прежнему приходят с сервера.
 */
export function PlanDetail({ plan, billing, active }: {
  plan: Plan;
  billing: BillingData;
  active: boolean;
}) {
  const [consent, setConsent] = useState<CheckoutConsentState>({ ready: false, autoRenew: false });
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(false);
  const enabled = Boolean(billing.paymentsEnabled);
  const recurring = Boolean(billing.subscription?.recurringAvailable);
  const paidPlan = plan.id !== "free";
  const subscription = billing.subscription;

  async function pay() {
    if (!consent.ready) {
      setError("Отметьте согласие на обработку данных и принятие оферты — без этого оплата недоступна.");
      return;
    }
    setPaying(true);
    setError("");
    try {
      const checkout = await startCheckout(plan.id as "pro" | "team", consent.autoRenew);
      writePlanChoice(plan.id);
      window.location.assign(checkout.paymentUrl);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPaying(false);
    }
  }

  /** Пока оплата не подключена, выбор сохраняется и включится вместе с ней. */
  function choose() {
    writePlanChoice(plan.id);
    setChosen(true);
  }

  return <article className="plan-detail">
    <header className="plan-detail-head">
      <div className="plan-detail-badges">
        {active ? <span className="plan-badge">Ваш тариф</span> : plan.recommended ? <span className="plan-badge">Популярный выбор</span> : <span className="plan-badge">Тариф</span>}
        {chosen && !active && <span className="plan-badge chosen-badge">Выбран · включим с оплатой</span>}
      </div>
      <div className="plan-detail-title">
        <div>
          <h1>{plan.name}</h1>
          {plan.description !== plan.tagline && <p className="plan-detail-tagline">{plan.tagline}</p>}
          <p className="plan-detail-description">{plan.description}</p>
        </div>
        <div className="plan-detail-price">
          {Boolean(plan.discountPercent) && <s>{plan.basePriceLabel}</s>}
          <strong>{plan.priceLabel}</strong>
          <small>{paidPlan ? "в месяц" : "навсегда"}</small>
        </div>
      </div>
      {plan.audience && <p className="plan-detail-audience">{plan.audience}</p>}
      {active && subscription?.renewsAt && <div className="plan-detail-subscription">
        <ShieldCheck size={13}/>
        <span>{subscription.autoRenew ? "Подписка с автопродлением" : "Подписка без автопродления"} · действует до {dateLabel(subscription.renewsAt)}</span>
      </div>}
    </header>

    <div className="plan-detail-body">
      <ul className="plan-feature-list">
        {plan.features.map(feature => <li key={feature}><Check size={13}/>{feature}</li>)}
      </ul>
      {plan.details.length > 0 && <details className="plan-detail-more">
        <summary>Подробнее о тарифе</summary>
        <ul className="plan-detail-list">{plan.details.map(detail => <li key={detail}>{detail}</li>)}</ul>
      </details>}
    </div>

    <div className="plan-detail-checkout">
      {paidPlan && enabled ? <>
        <CheckoutConsent recurring={recurring} onChange={setConsent}/>
        {error && <div className="settings-error">{error}</div>}
        <button type="button" className="send-button plan-pay-button" onClick={() => void pay()} disabled={paying || !consent.ready} title={consent.ready ? undefined : "Отметьте обязательные согласия выше"}>
          {paying
            ? <><RefreshCw size={13} className="spin"/> Открываем оплату…</>
            : <><CreditCard size={14}/> {active ? "Продлить" : "Оплатить"} {plan.priceLabel}</>}
        </button>
        <p className="checkout-consent-note">Оплата проходит на стороне «Робокассы»: данные карты вводятся там и в NestDev не попадают. Чек приходит на контакт из аккаунта.</p>
      </> : paidPlan ? <>
        {error && <div className="settings-error">{error}</div>}
        <button type="button" className="plan-action plan-select-button" onClick={choose} disabled={chosen || active}>
          {active ? "Текущий тариф" : chosen ? "Выбран · включим с оплатой" : "Выбрать тариф"}
        </button>
        <p className="checkout-consent-note">{paymentNotice(billing)}</p>
      </> : <div className="plan-detail-free">
        <ShieldCheck size={14}/>
        <span>{active ? "Это ваш текущий тариф" : "Бесплатный тариф входит всегда"}</span>
      </div>}
    </div>
  </article>;
}
