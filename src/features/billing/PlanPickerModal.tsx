import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { getBilling, paymentsPendingNotice, type BillingData, type PlanId } from "../../lib/billing-api";
import { activePlanId, planName, readPlanChoice, writePlanChoice } from "../../lib/plan-choice";

/**
 * Plan picker shown as a modal over the home page. Choosing a plan only records the choice:
 * payment is not connected yet, so no plan is enabled and nothing is charged.
 */
export function PlanPickerModal({ open, onClose, onOpenDetails, onChanged }: {
  open: boolean;
  onClose: () => void;
  onOpenDetails: () => void;
  onChanged?: () => void;
}) {
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [selected, setSelected] = useState<PlanId | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Callbacks are kept in refs so the open effect does not re-run on every render.
  const closeRef = useRef(onClose);
  const changedRef = useRef(onChanged);
  closeRef.current = onClose;
  changedRef.current = onChanged;

  useEffect(() => {
    if (!open) return;
    let active = true;
    // The stored choice is the plan the user wants to move to, so the picker reopens on it.
    setSelected(readPlanChoice()); setError(""); setLoading(true);
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

  /** Selecting a plan remembers it everywhere: it is the plan the user wants to move to. */
  function choose(plan: PlanId | null) {
    setSelected(plan);
    writePlanChoice(plan);
    changedRef.current?.();
  }

  if (!open) return null;

  const current = activePlanId();
  const chosen = selected ? billing?.plans.find(plan => plan.id === selected) : undefined;

  return <div className="modal-backdrop" role="presentation" onMouseDown={() => closeRef.current()}>
    <section className="modal plan-modal" role="dialog" aria-modal="true" aria-label="Выбор тарифа" onMouseDown={event => event.stopPropagation()}>
      <header className="modal-head">
        <div>
          <span className="eyebrow">ПОДПИСКА</span>
          <h2>Выберите тариф</h2>
        </div>
        <button className="icon-button" onClick={() => closeRef.current()} aria-label="Закрыть"><X size={16}/></button>
      </header>

      <div className="modal-body">
        <p className="modal-lead">{paymentsPendingNotice}</p>

        {loading && <div className="modal-state"><RefreshCw size={14} className="spin"/> Загружаем тарифы…</div>}

        {billing && <>
          <div className="subscription-current">
            <div><span>Текущий тариф</span><strong>{planName(billing, current)}</strong></div>
            <span className="plan-pill"><Sparkles size={12}/> ОПЛАТА СКОРО</span>
          </div>
          <p className="account-muted">{chosen
            ? "Выбран тариф «" + chosen.name + "» · " + chosen.priceLabel + ". Включим его, когда подключим оплату."
            : "Тариф можно выбрать заранее: выбор сохранится и включится вместе с оплатой."}</p>

          <div className="plan-grid">
            {billing.plans.map(plan => <article key={plan.id} className={"plan-card" + (plan.id === current ? " selected" : "") + (selected === plan.id ? " chosen" : "")}>
              <div className="plan-card-head">
                <div><strong>{plan.name}</strong><small>{plan.description}</small></div>
                <span>{plan.priceLabel}</span>
              </div>
              <ul>{plan.features.map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
              {plan.id === current
                ? <span className="plan-current">Текущий тариф</span>
                : <button className="plan-action" onClick={() => choose(plan.id)}>{selected === plan.id ? "Выбран · оплата скоро" : "Выбрать тариф"}</button>}
            </article>)}
          </div>

          {chosen && <div className="plan-confirm">
            <div><strong>Выбран тариф «{chosen.name}» · {chosen.priceLabel}</strong><span>Тариф включится вместе с оплатой — выбор уже сохранён.</span></div>
            <div className="plan-confirm-actions">
              <button className="ghost-button" onClick={() => choose(null)}>Убрать выбор</button>
              <button className="plan-action" onClick={() => closeRef.current()}>Готово</button>
            </div>
          </div>}

          <div className="billing-disclaimer">Лимиты тарифов предварительные и могут измениться до запуска оплаты.</div>
        </>}

        {error && <div className="settings-error">{error}</div>}
      </div>

      <footer className="modal-foot">
        <button className="ghost-button" onClick={onOpenDetails}>Подробнее о тарифах <ArrowRight size={13}/></button>
        <button className="send-button" onClick={() => closeRef.current()}>Готово</button>
      </footer>
    </section>
  </div>;
}
