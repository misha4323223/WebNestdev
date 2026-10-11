import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { activateDemoPlan, getBilling, planDateLabel, subscriptionSummary, type BillingData, type PlanId } from "../../lib/billing-api";
import { readPlanChoice, writePlanChoice } from "../../lib/plan-choice";

/**
 * Plan picker shown as a modal over the home page. Everything here is demo:
 * the chosen plan is activated for 30 days and no payment is collected.
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
  const [busyPlan, setBusyPlan] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Callbacks are kept in refs so the open effect does not re-run on every render.
  const closeRef = useRef(onClose);
  const changedRef = useRef(onChanged);
  closeRef.current = onClose;
  changedRef.current = onChanged;

  useEffect(() => {
    if (!open) return;
    let active = true;
    // The stored choice is the plan that will be paid for, so the picker reopens on it.
    setSelected(readPlanChoice()); setNotice(""); setError(""); setLoading(true);
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

  /** Selecting a plan remembers it everywhere; it is the plan that will be paid for. */
  function choose(plan: PlanId | null) {
    setSelected(plan);
    writePlanChoice(plan);
  }

  async function activate(plan: "pro" | "team") {
    setBusyPlan(plan); setError(""); setNotice("");
    try {
      const result = await activateDemoPlan(plan);
      setBilling(await getBilling());
      choose(plan);
      setNotice(result.message ?? "Демо-тариф активирован.");
      changedRef.current?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyPlan("");
    }
  }

  if (!open) return null;

  const currentPlanId = billing?.subscription.plan;
  const demoActive = billing?.subscription.status === "demo_active";
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
        <p className="modal-lead">Демо-режим: тариф включается на 30 дней без оплаты и банковской карты. Реальные списания отключены.</p>

        {loading && <div className="modal-state"><RefreshCw size={14} className="spin"/> Загружаем тарифы…</div>}

        {billing && <>
          <div className="subscription-current">
            <div><span>Текущий тариф</span><strong>{billing.plans.find(plan => plan.id === billing.subscription.plan)?.name ?? "Бесплатный"}</strong></div>
            <span className="demo-pill"><Sparkles size={12}/> {demoActive ? "Демо до " + planDateLabel(billing.subscription.expiresAt) : "Только демо"}</span>
          </div>
          <p className="account-muted">{subscriptionSummary(billing.subscription)}{chosen ? " Выбран к оплате тариф «" + chosen.name + "» — " + chosen.priceLabel + "." : ""}</p>

          <div className="plan-grid">
            {billing.plans.map(plan => {
              const active = plan.id === billing.subscription.plan && demoActive;
              return <article key={plan.id} className={"plan-card" + (plan.id === billing.subscription.plan ? " selected" : "") + (selected === plan.id ? " chosen" : "")}>
                <div className="plan-card-head">
                  <div><strong>{plan.name}</strong><small>{plan.description}</small></div>
                  <span>{plan.priceLabel}</span>
                </div>
                <ul>{plan.features.map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
                {plan.id === "free"
                  ? <span className="plan-current">{currentPlanId === "free" ? "Текущий тариф" : "Бесплатный тариф"}</span>
                  : active
                    ? <span className="plan-current">Активен (демо)</span>
                    : <button className="plan-action" disabled={Boolean(busyPlan)} onClick={() => choose(plan.id as "pro" | "team")}>{selected === plan.id ? "Выбран · будет оплачен" : "Выбрать тариф"}</button>}
              </article>;
            })}
          </div>

          {chosen && <div className="plan-confirm">
            <div><strong>Выбран тариф «{chosen.name}» · {chosen.priceLabel}</strong><span>Это тариф к оплате. Сейчас он включается демо-режимом на 30 дней, без платежей.</span></div>
            <div className="plan-confirm-actions">
              <button className="ghost-button" onClick={() => choose(null)} disabled={Boolean(busyPlan)}>Отмена</button>
              <button className="plan-action" onClick={() => void activate(chosen.id as "pro" | "team")} disabled={Boolean(busyPlan)}>{busyPlan === chosen.id ? "Активируем…" : "Подтвердить"}</button>
            </div>
          </div>}

          <div className="billing-disclaimer">Демо-режим: платежи, банковские карты и реальные списания отключены. Тарифы пока демонстрационные.</div>
        </>}

        {error && <div className="settings-error">{error}</div>}
        {notice && <div className="settings-status">{notice}</div>}
      </div>

      <footer className="modal-foot">
        <button className="ghost-button" onClick={onOpenDetails}>Подробнее о тарифах <ArrowRight size={13}/></button>
        <button className="send-button" onClick={() => closeRef.current()}>Готово</button>
      </footer>
    </section>
  </div>;
}
