import { useState } from "react";
import { CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import {
  creditPriceRub,
  creditsLabel,
  paymentStatusLabel,
  rubLabel,
  shortDayLabel,
  startCreditCheckout,
  type BillingData,
} from "../../lib/billing-api";
import { CheckoutConsent, type CheckoutConsentState } from "./CheckoutConsent";

/**
 * Докупка кредитов сверх месячного лимита тарифа.
 *
 * Человек вводит любое количество от серверного минимума; цену за 1000 кредитов задаёт админка,
 * а итоговую сумму считает сервер. Клиент показывает ту же оценку, но оплата всегда идёт по
 * сумме из ответа `/api/billing/credits/checkout`, поэтому подменить цену запросом нельзя.
 * Докупленные кредиты не сгорают, поэтому блок показывает их отдельно от месячной шкалы.
 */
export function CreditTopUp({ billing, paid, compact = false }: {
  billing: BillingData;
  paid: boolean;
  compact?: boolean;
}) {
  const topUp = billing.creditTopUp;
  const purchases = billing.creditPurchases ?? [];
  const minCredits = topUp?.minCredits ?? 1_000;
  const maxCredits = topUp?.maxCredits ?? 100_000;
  const [rawCredits, setRawCredits] = useState(String(minCredits));
  const [consent, setConsent] = useState<CheckoutConsentState>({ ready: false, autoRenew: false });
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const purchased = billing.credits?.purchased ?? 0;
  const enabled = Boolean(billing.paymentsEnabled);

  const credits = Number(rawCredits);
  const hasValue = rawCredits.trim() !== "" && Number.isSafeInteger(credits);
  const tooFew = hasValue && credits < minCredits;
  const tooMany = hasValue && credits > maxCredits;
  const valid = Boolean(topUp) && hasValue && !tooFew && !tooMany;
  const amount = topUp && valid ? creditPriceRub(credits, topUp.pricePer1000Rub) : 0;
  const amountHint = !hasValue
    ? "Введите количество кредитов"
    : tooFew
      ? "Минимум — " + creditsLabel(minCredits) + " кредитов"
      : tooMany
        ? "Максимум — " + creditsLabel(maxCredits) + " кредитов"
        : creditsLabel(credits) + " кредитов";

  async function pay() {
    if (!topUp) {
      setError("Настройки докупки временно недоступны. Попробуйте позже.");
      return;
    }
    if (!valid) {
      setError("Введите количество кредитов в допустимых границах.");
      return;
    }
    if (!consent.ready) {
      setError("Отметьте согласие на обработку данных и принятие оферты — без этого оплата недоступна.");
      return;
    }
    setPaying(true);
    setError("");
    try {
      const checkout = await startCreditCheckout(credits);
      window.location.assign(checkout.paymentUrl);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setPaying(false);
    }
  }

  return <section id="credit-topup" className={"credit-topup" + (compact ? " compact" : "")}>
    <div className="credit-topup-head">
      <div>
        <span className="eyebrow">КРЕДИТЫ</span>
        <h2>Докупить кредиты</h2>
        <p>{topUp
          ? "Введите количество кредитов. Минимум — " + creditsLabel(minCredits) + "; цена — " + topUp.pricePer1000Label + " за 1 000. Докупленные кредиты не сгорают и расходуются после кредитов тарифа."
          : "Докупка временно недоступна: не удалось загрузить настройки цены. Попробуйте позже."}</p>
      </div>
      {paid && <div className="credit-topup-balance">
        <span>Докуплено</span>
        <strong>{creditsLabel(purchased)}</strong>
        <small>не сгорают</small>
      </div>}
    </div>

    {!paid
      ? <div className="credit-topup-locked">
          <ShieldCheck size={15}/>
          <div>
            <strong>Докупка доступна на платных тарифах</strong>
            <span>На «Старте» действует дневной лимит запусков. На «Плюсе» и «Премиуме» можно купить любое количество кредитов.</span>
          </div>
        </div>
      : !enabled
        ? <div className="credit-topup-locked">
            <ShieldCheck size={15}/>
            <div>
              <strong>Оплата скоро</strong>
              <span>Приём платежей ещё не подключён. Докупка кредитов появится здесь сразу после запуска оплаты.</span>
            </div>
          </div>
        : !topUp
          ? <div className="credit-topup-locked"><ShieldCheck size={15}/><div><span>Настройки докупки временно недоступны. Попробуйте позже.</span></div></div>
          : <>
              <div className="credit-topup-form">
                <label className="credit-topup-amount" htmlFor="credit-amount">
                  <span>Сколько кредитов</span>
                  <div className="credit-topup-amount-row">
                    <input
                      id="credit-amount"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="off"
                      aria-describedby="credit-amount-hint"
                      aria-invalid={tooFew || tooMany}
                      value={rawCredits}
                      onChange={event => {
                        setRawCredits(event.target.value.replace(/\D/g, ""));
                        setError("");
                      }}
                    />
                    <em>кредитов</em>
                  </div>
                  <small id="credit-amount-hint" className={tooFew || tooMany ? "warning" : ""}>{amountHint}</small>
                </label>
                <div className="credit-topup-total">
                  <span>К оплате</span>
                  <strong>{valid ? rubLabel(amount) : "—"}</strong>
                  <small>{valid ? "за " + creditsLabel(credits) + " кредитов" : "по цене за 1 000"}</small>
                </div>
              </div>

              <CheckoutConsent purpose="credits" recurring={false} onChange={setConsent}/>
              {error && <div className="settings-error credit-topup-error" role="alert">{error}</div>}
              <button
                type="button"
                className="send-button credit-topup-pay"
                disabled={paying || !consent.ready || !valid}
                onClick={() => void pay()}
              >
                {paying
                  ? <><RefreshCw size={13} className="spin"/> Открываем оплату…</>
                  : <><CreditCard size={14}/> Купить {valid ? creditsLabel(credits) + " кредитов · " + rubLabel(amount) : "кредиты"}</>}
              </button>
              <p className="checkout-consent-note">Оплата проходит на стороне «Робокассы». После подтверждения кредиты сразу появятся в бюджете аккаунта.</p>
            </>}

    {purchases.length > 0 && <details className="credit-topup-history">
      <summary>История докупок <span>{purchases.length}</span></summary>
      <div className="billing-payments">
        {purchases.slice(0, 6).map(purchase => <div className="billing-payment" key={purchase.invId}>
          <div>
            <strong>{creditsLabel(purchase.credits)} кредитов · {rubLabel(purchase.amount)}</strong>
            <small>Счёт №{purchase.invId} · {shortDayLabel(purchase.createdAt.slice(0, 10))}</small>
          </div>
          <span className={"billing-payment-status " + purchase.status}>{paymentStatusLabel(purchase.status)}</span>
        </div>)}
      </div>
    </details>}
  </section>;
}
