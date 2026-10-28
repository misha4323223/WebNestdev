import { useEffect,useState } from "react";
import { Check,Loader2,Percent,RefreshCw } from "lucide-react";
import { apiJson } from "../../lib/api";

/**
 * Витрина тарифов для администратора платформы: название, описание, базовая цена и скидка.
 *
 * Скидка не меняет базовую цену в каталоге: сервер считает итоговую сумму сам и применяет
 * её в счёте, чеке и на этой же витрине. Поэтому здесь сразу видно, какая цена зачёркнута,
 * а какая уйдёт в оплату — админ не проверяет это отдельной покупкой.
 */
type AdminPlanId = "pro" | "team";
type AdminPlan = {
  id: AdminPlanId;
  name: string;
  description: string;
  priceRub: number;
  discountPercent: number;
  priceLabel: string;
  basePriceLabel: string;
};
type PlansResponse = { admin?: boolean; plans?: AdminPlan[] };
type Draft = { name: string; description: string; priceRub: string; discountPercent: string };

function draftOf(plan: AdminPlan): Draft {
  return {
    name: plan.name,
    description: plan.description,
    priceRub: String(plan.priceRub),
    discountPercent: String(plan.discountPercent),
  };
}

function numberValue(value: string) {
  return Number(value.trim().replace(/\s/g, "").replace(",", "."));
}

function rubLabel(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString("ru-RU") + " ₽";
}

function preview(base: number, percent: number) {
  const safeBase = Number.isFinite(base) && base > 0 ? Math.round(base) : 0;
  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(90, Math.round(percent))) : 0;
  return {
    base: safeBase,
    percent: safePercent,
    final: safeBase ? Math.max(1, Math.round(safeBase * (100 - safePercent) / 100)) : 0,
  };
}

export function AdminPlansPanel() {
  const [plans,setPlans]=useState<AdminPlan[]>([]);
  const [drafts,setDrafts]=useState<Record<string,Draft>>({});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");

  function apply(data: PlansResponse) {
    const next = data.plans ?? [];
    setPlans(next);
    setDrafts(Object.fromEntries(next.map(plan => [plan.id, draftOf(plan)])));
  }

  async function load() {
    setLoading(true); setError(""); setStatus("");
    try {
      const data = await apiJson<PlansResponse>("/api/platform/plans");
      if (!data.admin) { setError("Раздел доступен только администратору платформы."); return; }
      apply(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось загрузить тарифы");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  function update(id: AdminPlanId, field: keyof Draft, value: string) {
    setDrafts(current => ({ ...current, [id]: { ...current[id], [field]: value } }));
    setStatus("");
  }

  async function save() {
    const body: Partial<Record<AdminPlanId, { name: string; description: string; priceRub: number; discountPercent: number }>> = {};
    for (const plan of plans) {
      const draft = drafts[plan.id];
      if (!draft) continue;
      const name = draft.name.trim();
      const description = draft.description.trim();
      const priceRub = numberValue(draft.priceRub);
      const discountPercent = numberValue(draft.discountPercent || "0");
      if (!name) { setError("У тарифа «" + plan.name + "» не заполнено название."); return; }
      if (!description) { setError("У тарифа «" + name + "» не заполнено описание."); return; }
      if (!Number.isInteger(priceRub) || priceRub < 1) { setError("У тарифа «" + name + "» цена должна быть целым числом рублей больше нуля."); return; }
      if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 90) { setError("У тарифа «" + name + "» скидка должна быть целым числом от 0 до 90%."); return; }
      body[plan.id] = { name, description, priceRub, discountPercent };
    }
    if (!body.pro || !body.team) { setError("Не хватает данных одного из тарифов — обновите раздел и попробуйте снова."); return; }

    setBusy(true); setError(""); setStatus("");
    try {
      const data = await apiJson<PlansResponse>("/api/platform/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      apply(data);
      setStatus("Сохранено: витрина, счёт и чек уже используют новые цены.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось сохранить тарифы");
    } finally { setBusy(false); }
  }

  return <section className="settings-panel admin-plans">
    <div className="panel-title">
      <div><span className="eyebrow">ТАРИФЫ И СКИДКИ</span><strong>Витрина подписок</strong></div>
      <button className="ghost-button" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={13}/> Обновить</button>
    </div>
    <div className="settings-body">
      <div className="settings-status">
        Скидка применяется к новой оплате и к следующему списанию. Базовая цена остаётся в каталоге,
        на витрине она зачёркнута, а итоговая сумма уходит в счёт Робокассы.
      </div>

      {loading && <div className="modal-state"><Loader2 size={14} className="spin"/> Загружаем тарифы…</div>}
      {error && <div className="settings-error">{error}</div>}

      {!loading && <div className="admin-plan-grid">
        {plans.map(plan => {
          const draft = drafts[plan.id];
          if (!draft) return null;
          const price = numberValue(draft.priceRub);
          const discount = numberValue(draft.discountPercent || "0");
          const shown = preview(price, discount);
          return <article className="admin-plan-card" key={plan.id}>
            <div className="admin-plan-head">
              <span className="admin-plan-tag">{plan.id.toUpperCase()}</span>
              <strong>{draft.name || plan.name}</strong>
            </div>

            <label className="admin-plan-field">
              <span>Название</span>
              <input value={draft.name} maxLength={48} onChange={event => update(plan.id, "name", event.target.value)} placeholder="Например, Плюс"/>
            </label>

            <label className="admin-plan-field">
              <span>Описание</span>
              <textarea value={draft.description} maxLength={180} rows={3} onChange={event => update(plan.id, "description", event.target.value)} placeholder="Что человек получает на этом тарифе"/>
            </label>

            <div className="admin-plan-row">
              <label className="admin-plan-field">
                <span>Цена, ₽/мес</span>
                <input value={draft.priceRub} inputMode="numeric" onChange={event => update(plan.id, "priceRub", event.target.value)} placeholder="990"/>
              </label>
              <label className="admin-plan-field">
                <span>Скидка, %</span>
                <div className="admin-plan-discount">
                  <input value={draft.discountPercent} inputMode="numeric" onChange={event => update(plan.id, "discountPercent", event.target.value)} placeholder="0"/>
                  <Percent size={11}/>
                </div>
              </label>
            </div>

            <div className="admin-plan-preview" aria-live="polite">
              <span>Увидит человек</span>
              <div className="admin-plan-price">
                {shown.percent > 0 && <s>{rubLabel(shown.base)}</s>}
                <strong>{rubLabel(shown.final)}</strong>
                <small>/ мес</small>
                {shown.percent > 0 && <em>−{shown.percent}%</em>}
              </div>
            </div>
          </article>;
        })}
      </div>}

      {status && <div className="settings-status platform-result"><Check size={14}/><span>{status}</span></div>}
      <div className="model-row">
        <button className="send-button settings-save" onClick={() => void save()} disabled={loading || busy || !plans.length}>
          {busy ? <><Loader2 size={13} className="spin"/> Сохраняю…</> : <><Check size={13}/> Сохранить тарифы</>}
        </button>
        <span className="platform-counter">Изменения сразу попадают на витрину и в оплату</span>
      </div>
    </div>
  </section>;
}
