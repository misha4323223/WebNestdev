import { useState } from "react";
import { CreditCard, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import {
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
 * Пакет выбирается здесь, но сумму и количество кредитов считает сервер. После оплаты
 * Робокасса возвращает человека на главную, а баланс подтягивается из `/api/billing`.
 * Докупленные кредиты не сгорают, поэтому блок показывает их отдельно от месячной шкалы.
 */
export function CreditTopUp({ billing, paid, compact = false }: {
  billing: BillingData;
  paid: boolean;
  compact?: boolean;
}) {
  const packs = billing.creditPacks ?? [];
  const purchases = billing.creditPurchases ?? [];
  const [selectedId, setSelectedId] = useState("");
  const [consent, setConsent] = useState<CheckoutConsentState>({ ready: false, autoRenew: false });
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const selected = packs.find(pack => pack.id === selectedId)
    ?? packs.find(pack => pack.recommended)
    ?? packs[0];
  const purchased = billing.credits?.purchased ?? 0;
  const enabled = Boolean(billing.paymentsEnabled);

  async function pay() {
    if (!selected) return;
    if (!consent.ready) {
      setError("Отметьте согласие на обработку данных и принятие оферты — без этого оплата недоступна.");
      return;
    }
    setPaying(true);
    setError("");
    try {
      const checkout = await startCreditCheckout(selected.id);
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
        <p>Когда месячного лимита не хватает, добавьте пакет. Докупленные кредиты не сгорают и расходуются после кредитов тарифа.</p>
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
            <span>На «Старте» действует дневной лимит запусков. На «Плюсе» и «Премиуме» можно купить дополнительный пакет кредитов.</span>
          </div>
        </div>
      : !enabled
        ? <div className="credit-topup-locked">
            <ShieldCheck size={15}/>
            <div>
              <strong>Оплата скоро</strong>
              <span>Приём платежей ещё не подключён. Пакеты кредитов появятся здесь сразу после запуска оплаты.</span>
            </div>
          </div>
        : packs.length === 0
          ? <div className="credit-topup-locked"><ShieldCheck size={15}/><div><span>Пакеты кредитов временно недоступны. Попробуйте позже.</span></div></div>
          : <>
              <div className="credit-pack-grid" role="radiogroup" aria-label="Пакет кредитов">
                {packs.map(pack => {
                  const active = pack.id === selected?.id;
                  return <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    key={pack.id}
                    className={"credit-pack" + (active ? " selected" : "") + (pack.recommended ? " recommended" : "")}
                    onClick={() => { setSelectedId(pack.id); setError(""); }}
                  >
                    {pack.recommended && <span className="credit-pack-badge"><Sparkles size={10}/> Выгодный выбор</span>}
                    <span className="credit-pack-name">{pack.name}</span>
                    <strong>{rubLabel(pack.priceRub)}</strong>
                    <small>{pack.note}</small>
                    <span className="credit-pack-check" aria-hidden="true">{active ? "✓" : ""}</span>
                  </button>;
                })}
              </div>

              <CheckoutConsent purpose="credits" recurring={false} onChange={setConsent}/>
              {error && <div className="settings-error credit-topup-error" role="alert">{error}</div>}
              <button
                type="button"
                className="send-button credit-topup-pay"
                disabled={paying || !consent.ready || !selected}
                onClick={() => void pay()}
              >
                {paying
                  ? <><RefreshCw size={13} className="spin"/> Открываем оплату…</>
                  : <><CreditCard size={14}/> Купить {selected ? creditsLabel(selected.credits) + " кредитов" : "кредиты"}{selected ? " · " + rubLabel(selected.priceRub) : ""}</>}
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
