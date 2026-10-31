import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CreditCard, RefreshCw, Sparkles, X } from "lucide-react";
import { getBilling, paymentNotice, type BillingData, type PlanId } from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

/**
 * Выбор тарифа. Здесь остаются только карточки: нажатие открывает отдельный
 * компактный экран тарифа, где внизу стоят согласия и кнопка оплаты. Так галочки
 * не приходится искать под сеткой, а описание не дублируется в двух местах.
 */
export function PlanPickerModal({ open, onClose, onChoosePlan }: {
  open: boolean;
  onClose: () => void;
  onChoosePlan: (plan: PlanId) => void;
}) {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Callback is kept in a ref so the open effect does not re-run on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const planChoice = usePlanChoice();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(""); setLoading(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeRef.current(); };
    window.addEventListener("keydown", onKey);
    void getBilling()
      .then(data => { if (active) setBilling(data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!open) return null;

  const enabled = Boolean(billing?.paymentsEnabled);
  const current = activePlanId(billing);
  const chosenId = chosenPlanId(planChoice);
  const chosenPending = isPendingChoice(planChoice, billing);

  return <div className="modal-backdrop" role="presentation" onMouseDown={() => closeRef.current()}>
    <section className="modal plan-modal" role="dialog" aria-modal="true" aria-label="Выбор тарифа" onMouseDown={event => event.stopPropagation()}>
      <header className="modal-head">
        <div>
          <span className="eyebrow">ПОДПИСКА</span>
          <h2>Выберите тариф</h2>
        </div>
        <button className="icon-button" onClick={() => closeRef.current()} aria-label="Закрыть" title="Закрыть"><X size={16}/></button>
      </header>

      <div className="modal-body">
        <p className="modal-lead">Откройте карточку тарифа — там полное описание, условия и оплата. {paymentNotice(billing)}</p>

        {loading && <div className="modal-state"><RefreshCw size={14} className="spin"/> Загружаем тарифы…</div>}

        {billing && <>
          <div className="subscription-current">
            <div><span>Текущий тариф</span><strong>{planName(billing, current)}</strong></div>
            <span className="plan-pill">
              {enabled ? <><CreditCard size={12}/> ОПЛАТА КАРТОЙ И СБП</> : <><Sparkles size={12}/> ОПЛАТА СКОРО</>}
            </span>
          </div>
          <p className="account-muted">{billing.subscription?.renewsAt
            ? "Тариф действует до " + new Date(billing.subscription.renewsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) + ". Оплата продлевает срок от текущей даты окончания."
            : enabled
              ? "Оплата проходит на защищённой странице; тариф включается сразу после подтверждения платежа."
              : "Тариф можно выбрать заранее: выбор сохранится и включится вместе с оплатой."}</p>

          <div className="plan-grid">
            {billing.plans.map(plan => {
              const active = plan.id === current;
              const chosen = chosenPending && chosenId === plan.id;
              return <button
                type="button"
                key={plan.id}
                className={"plan-card plan-card-select" + (active ? " selected" : "") + (chosen ? " chosen" : "")}
                onClick={() => onChoosePlan(plan.id)}
                aria-label={"Открыть описание тарифа «" + plan.name + "»"}
              >
                <div className="plan-card-head">
                  <div><strong>{plan.name}</strong><small>{plan.description}</small></div>
                  <span className="plan-card-price">
                    {Boolean(plan.discountPercent)&&<s>{plan.basePriceLabel}</s>}
                    <b>{plan.priceLabel}</b>
                  </span>
                </div>
                {active
                  ? <span className="plan-badge">Ваш тариф</span>
                  : chosen
                    ? <span className="plan-badge">{enabled ? "Выбран" : "Выбран · оплата скоро"}</span>
                    : plan.recommended ? <span className="plan-badge">Популярный выбор</span> : null}
                <ul>{plan.features.slice(0, 4).map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
                <span className="plan-card-open">{active ? "Текущий тариф" : "Описание и оплата"} <ArrowRight size={12}/></span>
              </button>;
            })}
          </div>
        </>}

        {error && <div className="settings-error">{error}</div>}
      </div>

      <footer className="modal-foot">
        <span className="account-muted modal-foot-note">Нажмите карточку, чтобы открыть тариф.</span>
        <button className="send-button" onClick={() => closeRef.current()}>Готово</button>
      </footer>
    </section>
  </div>;
}
