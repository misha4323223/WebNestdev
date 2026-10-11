import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";
import { applyPreferences, type UserPreferences } from "../../lib/preferences";
import { activateDemoPlan, cancelDemoPlan, getBilling, moneyLabel, planDateLabel, type BillingData } from "../../lib/billing-api";
import { chosenPlanId, isPendingChoice, planName, usePlanChoice, writePlanChoice } from "../../lib/plan-choice";
import { Check, CreditCard, Settings2, ShieldCheck, Sparkles, UserRound } from "lucide-react";

type Preferences = UserPreferences;
type AccountData = { user: { id: string; email: string; createdAt: string }; preferences: Preferences };

const initialPreferences: Preferences = { language: "ru", compactMode: false, emailNotifications: true, productUpdates: false };
const tokenLabel = (value: number) => value.toLocaleString("ru-RU");

export function AccountSettingsPanel() {
  const [section, setSection] = useState<"account" | "preferences" | "subscription">("account");
  const [account, setAccount] = useState<AccountData | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(initialPreferences);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyPlan, setBusyPlan] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<"pro" | "team" | null>(null);
  // The chosen plan is shared state: it is the plan that will be paid for, so the
  // settings screen names it exactly like the home rail and the top bar do.
  const planChoice = usePlanChoice();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function reload() {
    setLoading(true); setError("");
    try {
      const [accountData, billingData] = await Promise.all([apiJson<AccountData>("/api/account/settings"), getBilling()]);
      setAccount(accountData); setPreferences(accountData.preferences); setBilling(billingData); applyPreferences(accountData.preferences);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);

  async function savePreferences() {
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await apiJson<{ preferences: UserPreferences }>("/api/account/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(preferences) });
      setPreferences(result.preferences); applyPreferences(result.preferences); setNotice("Настройки сохранены.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  async function activate(plan: "pro" | "team") {
    setBusyPlan(plan); setError(""); setNotice("");
    try {
      await activateDemoPlan(plan);
      setSelectedPlan(null);
      await reload(); setNotice("Демо-тариф активирован на 30 дней. Оплата не выполнялась.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyPlan(""); }
  }
  async function cancelDemo() {
    setBusyPlan("cancel"); setError(""); setNotice("");
    try {
      await cancelDemoPlan();
      await reload(); setNotice("Демо-подписка отменена. Платежей не было.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyPlan(""); }
  }

  const nav = [{ id: "account", label: "Аккаунт", icon: UserRound }, { id: "preferences", label: "Предпочтения", icon: Settings2 }, { id: "subscription", label: "Тариф и подписка", icon: CreditCard }] as const;
  const activePlan = billing?.plans.find(plan => plan.id === billing.subscription.plan);
  const chosenPlanIdValue = billing ? chosenPlanId(billing, planChoice) : null;
  const chosenPending = billing ? isPendingChoice(billing, planChoice) : false;
  const usageRows = billing ? [
    { label: "Запуски агента", used: billing.usage.agentRuns, limit: billing.limits.agentRunsPerDay },
    { label: "Браузерные проверки", used: billing.usage.browserChecks, limit: billing.limits.browserChecksPerDay },
  ] : [];
  return <section className="account-settings settings-panel">
    <div className="panel-title"><div><span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span><strong>Настройки аккаунта</strong></div><span className="demo-pill"><ShieldCheck size={12}/> ДЕМО-РЕЖИМ</span></div>
    {loading ? <div className="settings-body">Загружаем настройки аккаунта…</div> : <>
      <div className="account-settings-layout">
        <nav className="account-settings-nav">{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setError(""); setNotice(""); }}><Icon size={14}/>{item.label}</button>; })}</nav>
        <div className="account-settings-content">
          {section === "account" && <div className="account-section">
            <span className="eyebrow">ПРОФИЛЬ</span><h3>Профиль</h3><p className="account-muted">Основная информация вашего аккаунта WebNestdev.</p>
            <label>Email<input value={account?.user.email ?? ""} readOnly/></label>
            <label>ID аккаунта<input value={account?.user.id ?? ""} readOnly/></label>
            <label>Дата регистрации<input value={planDateLabel(account?.user.createdAt ?? null)} readOnly/></label>
            <div className="account-note"><ShieldCheck size={14}/> Данные аккаунта доступны только после авторизации.</div>
          </div>}
          {section === "preferences" && <div className="account-section">
            <span className="eyebrow">ПРЕДПОЧТЕНИЯ</span><h3>Предпочтения</h3><p className="account-muted">Параметры сохраняются на сервере и привязаны к вашему аккаунту. Компактный режим применяется сразу.</p>
            <div className="pref-row"><span className="pref-label">Язык интерфейса</span><span className="pref-value">Русский<span className="pref-tag">другие языки позже</span></span></div>
            <label className="account-toggle"><span><strong>Компактный режим</strong><small>Меньше отступов в рабочих панелях — включается мгновенно</small></span><span className="switch"><input type="checkbox" checked={preferences.compactMode} onChange={e => { const next = { ...preferences, compactMode: e.target.checked }; setPreferences(next); applyPreferences(next); }}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <label className="account-toggle is-soon"><span><strong>Email-уведомления<span className="soon-pill">скоро</span></strong><small>Писем пока не отправляем: подключим вместе с почтовым сервисом</small></span><span className="switch"><input type="checkbox" checked={preferences.emailNotifications} disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <label className="account-toggle is-soon"><span><strong>Новости продукта<span className="soon-pill">скоро</span></strong><small>Рассылка обновлений WebNestdev — тоже после подключения почты</small></span><span className="switch"><input type="checkbox" checked={preferences.productUpdates} disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <button className="send-button account-save" disabled={saving} onClick={() => void savePreferences()}>{saving ? "Сохраняем…" : "Сохранить настройки"}</button>
          </div>}
          {section === "subscription" && <div className="account-section">
            <span className="eyebrow">ПОДПИСКА</span><h3>Тариф и подписка</h3>
            <div className="subscription-current"><div><span>Текущий тариф</span><strong>{activePlan?.name ?? "Бесплатный"}</strong></div><span className="demo-pill"><Sparkles size={12}/> Только демо</span></div>
            {billing && chosenPlanIdValue && <div className="plan-choice-note">
              <span>{chosenPending ? "Выбранный тариф · будет оплачен" : "Выбранный тариф уже активен"}</span>
              <strong>{planName(billing, chosenPlanIdValue)} · {billing.plans.find(plan => plan.id === chosenPlanIdValue)?.priceLabel}</strong>
            </div>}
            <p className="account-muted">{billing?.subscription.status === "demo_active" ? `Демо действует до ${planDateLabel(billing.subscription.expiresAt)}.` : billing?.subscription.status === "demo_cancelled" ? "Демо-подписка отменена." : billing?.subscription.status === "demo_expired" ? "Срок демо закончился. Доступен бесплатный тариф." : "Бесплатный режим активен. Можно включить демо-тариф на 30 дней."}</p>
            <div className="usage-meter-list"><div className="usage-meter-title"><strong>Использование за сегодня</strong><small>Сброс по UTC · {billing?.usage.date ?? ""}</small></div>{usageRows.map(row => <div className="usage-meter" key={row.label}><div><span>{row.label}</span><strong>{row.used} / {row.limit}</strong></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, row.used / Math.max(1, row.limit) * 100)}%` }}/></div></div>)}</div>
            {billing?.cost && <div className="usage-meter-list"><div className="usage-meter-title"><strong>Расход модели за сегодня</strong><small>{billing.cost.pricesConfigured ? (billing.cost.exact ? "по данным провайдера" : "оценка по объёму") : "цены не заданы"}</small></div><div className="usage-meter"><div><span>Прогонов</span><strong>{billing.cost.runs}</strong></div></div><div className="usage-meter"><div><span>Токены</span><strong>{tokenLabel(billing.cost.promptTokens)} вход / {tokenLabel(billing.cost.completionTokens)} выход</strong></div></div><div className="usage-meter"><div><span>Оценка расходов</span><strong>{billing.cost.pricesConfigured ? moneyLabel(billing.cost.costEstimate, billing.cost.currency) : "—"}</strong></div></div>{billing.cost.lastRun && <div className="usage-meter"><div><span>Последний прогон</span><strong>{billing.cost.lastRun.model} · {tokenLabel(billing.cost.lastRun.promptTokens)} / {tokenLabel(billing.cost.lastRun.completionTokens)} токенов · {new Date(billing.cost.lastRun.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}{billing.cost.pricesConfigured ? " · " + moneyLabel(billing.cost.lastRun.costEstimate, billing.cost.currency) : ""}</strong></div></div>}</div>}
            <div className="plan-grid">{billing?.plans.map(plan => { const active = plan.id === billing.subscription.plan && billing.subscription.status === "demo_active"; return <article key={plan.id} className={"plan-card" + (plan.id === billing.subscription.plan ? " selected" : "") + (selectedPlan === plan.id || (chosenPending && chosenPlanIdValue === plan.id) ? " chosen" : "")}>
              <div className="plan-card-head"><div><strong>{plan.name}</strong><small>{plan.description}</small></div><span>{plan.priceLabel}</span></div>
              <ul>{plan.features.map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
              {plan.id === "free" ? <span className="plan-current">{billing.subscription.plan === "free" ? "Текущий тариф" : "Бесплатный тариф"}</span>
                : active ? <span className="plan-current">Активен (демо)</span>
                : <button className="plan-action" disabled={Boolean(busyPlan)} onClick={() => { setSelectedPlan(plan.id as "pro" | "team"); writePlanChoice(plan.id); }}>{selectedPlan === plan.id ? "Выбран · будет оплачен" : chosenPending && chosenPlanIdValue === plan.id ? "Выбран · будет оплачен" : billing.subscription.plan === plan.id ? "Продлить демо" : "Выбрать тариф"}</button>}
            </article>; })}</div>
            {selectedPlan && billing && <div className="plan-confirm">
              <div><strong>Выбран тариф «{billing.plans.find(plan => plan.id === selectedPlan)?.name}»</strong><span>Демо на 30 дней · оплата не требуется</span></div>
              <div className="plan-confirm-actions">
                <button className="ghost-button" onClick={() => setSelectedPlan(null)} disabled={Boolean(busyPlan)}>Отмена</button>
                <button className="plan-action" onClick={() => void activate(selectedPlan)} disabled={Boolean(busyPlan)}>{busyPlan === selectedPlan ? "Активируем…" : "Подтвердить"}</button>
              </div>
            </div>}
            {billing?.subscription.status === "demo_active" && <button className="ghost-button account-cancel-demo" disabled={Boolean(busyPlan)} onClick={() => void cancelDemo()}>{busyPlan === "cancel" ? "Отменяем…" : "Отменить демо-подписку"}</button>}
            <p className="billing-disclaimer">Демо-режим: платежи, банковские карты и реальные списания отключены. Тарифы пока демонстрационные.</p>
          </div>}
        </div>
      </div>
    </>}
    {(error || notice) && <div className={error ? "settings-error account-feedback" : "settings-status account-feedback"}>{error || notice}</div>}
  </section>;
}
