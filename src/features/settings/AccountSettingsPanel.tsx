import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";
import { applyPreferences, type UserPreferences } from "../../lib/preferences";
import { dateLabel, getBilling, moneyLabel, paymentsPendingNotice, type BillingData } from "../../lib/billing-api";
import { activePlanId, usePlanChoice, writePlanChoice } from "../../lib/plan-choice";
import { openCookieSettings } from "../legal/CookieConsent";
import { Check, CreditCard, Settings2, ShieldCheck, UserRound } from "lucide-react";

type Preferences = UserPreferences;
type AccountData = { user: { id: string; email: string; createdAt: string; yandex?: { login: string; email: string | null } }; preferences: Preferences };

const initialPreferences: Preferences = { language: "ru", compactMode: false, emailNotifications: true, productUpdates: false };
const tokenLabel = (value: number) => value.toLocaleString("ru-RU");

export function AccountSettingsPanel() {
  const [section, setSection] = useState<"account" | "preferences" | "subscription">("account");
  const [account, setAccount] = useState<AccountData | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(initialPreferences);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // The chosen plan is shared state: it is the plan the user wants to move to, so the
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

  const nav = [{ id: "account", label: "Аккаунт", icon: UserRound }, { id: "preferences", label: "Предпочтения", icon: Settings2 }, { id: "subscription", label: "Тариф и подписка", icon: CreditCard }] as const;
  const currentPlanId = activePlanId();
  const activePlan = billing?.plans.find(plan => plan.id === currentPlanId);
  const chosenPlan = planChoice && billing ? billing.plans.find(plan => plan.id === planChoice) : undefined;
  const usageRows = billing ? [
    { label: "Запуски агента", used: billing.usage.agentRuns, limit: billing.limits.agentRunsPerDay },
    { label: "Браузерные проверки", used: billing.usage.browserChecks, limit: billing.limits.browserChecksPerDay },
  ] : [];
  return <section className="account-settings settings-panel">
    <div className="panel-title"><div><span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span><strong>Настройки аккаунта</strong></div></div>
    {loading ? <div className="settings-body">Загружаем настройки аккаунта…</div> : <>
      <div className="account-settings-layout">
        <nav className="account-settings-nav">{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setError(""); setNotice(""); }}><Icon size={14}/>{item.label}</button>; })}</nav>
        <div className="account-settings-content">
          {section === "account" && <div className="account-section">
            <span className="eyebrow">ПРОФИЛЬ</span><h3>Профиль</h3><p className="account-muted">Основная информация вашего аккаунта WebNestdev.</p>
            {account?.user.yandex && <label>Вход через Яндекс ID<input value={"@" + account.user.yandex.login} readOnly/></label>}
            {account?.user.yandex?.email && <label>Email Яндекс ID<input value={account.user.yandex.email ?? ""} readOnly/></label>}
            <label>{account?.user.yandex ? "Служебный адрес аккаунта" : "Email"}<input value={account?.user.email ?? ""} readOnly/></label>
            <label>ID аккаунта<input value={account?.user.id ?? ""} readOnly/></label>
            <label>Дата регистрации<input value={dateLabel(account?.user.createdAt ?? null)} readOnly/></label>
            <div className="account-note"><ShieldCheck size={14}/> {account?.user.yandex ? "Профиль подтверждён через Яндекс ID — данные видны только вам." : "Данные профиля защищены и видны только вам."}</div>
          </div>}
          {section === "preferences" && <div className="account-section">
            <span className="eyebrow">ПРЕДПОЧТЕНИЯ</span><h3>Предпочтения</h3><p className="account-muted">Параметры сохраняются на сервере и привязаны к вашему аккаунту. Компактный режим применяется сразу.</p>
            <div className="pref-row"><span className="pref-label">Язык интерфейса</span><span className="pref-value">Русский<span className="pref-tag">другие языки позже</span></span></div>
            <label className="account-toggle"><span><strong>Компактный режим</strong><small>Меньше отступов в рабочих панелях — включается мгновенно</small></span><span className="switch"><input type="checkbox" checked={preferences.compactMode} onChange={e => { const next = { ...preferences, compactMode: e.target.checked }; setPreferences(next); applyPreferences(next); }}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <label className="account-toggle is-soon"><span><strong>Email-уведомления<span className="soon-pill">скоро</span></strong><small>Писем пока не отправляем: подключим вместе с почтовым сервисом</small></span><span className="switch"><input type="checkbox" checked={preferences.emailNotifications} disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <label className="account-toggle is-soon"><span><strong>Новости продукта<span className="soon-pill">скоро</span></strong><small>Рассылка обновлений WebNestdev — тоже после подключения почты</small></span><span className="switch"><input type="checkbox" checked={preferences.productUpdates} disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <div className="account-pref-actions">
              <button type="button" className="ghost-button" onClick={openCookieSettings}>Cookie-настройки</button>
              <button className="send-button account-save" disabled={saving} onClick={() => void savePreferences()}>{saving ? "Сохраняем…" : "Сохранить настройки"}</button>
            </div>
          </div>}
          {section === "subscription" && <div className="account-section">
            <span className="eyebrow">ПОДПИСКА</span><h3>Тариф и подписка</h3>
            <div className="subscription-current"><div><span>Текущий тариф</span><strong>{activePlan?.name ?? "Бесплатный"}</strong></div><span className="plan-pill">ОПЛАТА СКОРО</span></div>
            {chosenPlan && <div className="plan-choice-note">
              <span>Выбранный тариф · включим вместе с оплатой</span>
              <strong>{chosenPlan.name} · {chosenPlan.priceLabel}</strong>
            </div>}
            <p className="account-muted">{paymentsPendingNotice}</p>
            <div className="usage-meter-list"><div className="usage-meter-title"><strong>Использование за сегодня</strong><small>Сброс по UTC · {billing?.usage.date ?? ""}</small></div>{usageRows.map(row => <div className="usage-meter" key={row.label}><div><span>{row.label}</span><strong>{row.used} / {row.limit}</strong></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, row.used / Math.max(1, row.limit) * 100)}%` }}/></div></div>)}</div>
            <p className="account-muted">Лимит запусков относится к встроенной модели платформы. Со своим AI-провайдером в проекте запуски идут через ваш ключ и модель — без дневной квоты.</p>
            {billing?.cost && <div className="usage-meter-list"><div className="usage-meter-title"><strong>Расход модели за сегодня</strong><small>{billing.cost.pricesConfigured ? (billing.cost.exact ? "по данным провайдера" : "оценка по объёму") : "цены не заданы"}</small></div><div className="usage-meter"><div><span>Прогонов</span><strong>{billing.cost.runs}</strong></div></div><div className="usage-meter"><div><span>Токены</span><strong>{tokenLabel(billing.cost.promptTokens)} вход / {tokenLabel(billing.cost.completionTokens)} выход</strong></div></div><div className="usage-meter"><div><span>Оценка расходов</span><strong>{billing.cost.pricesConfigured ? moneyLabel(billing.cost.costEstimate, billing.cost.currency) : "—"}</strong></div></div>{billing.cost.lastRun && <div className="usage-meter"><div><span>Последний прогон</span><strong>{billing.cost.lastRun.model} · {tokenLabel(billing.cost.lastRun.promptTokens)} / {tokenLabel(billing.cost.lastRun.completionTokens)} токенов · {new Date(billing.cost.lastRun.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}{billing.cost.pricesConfigured ? " · " + moneyLabel(billing.cost.lastRun.costEstimate, billing.cost.currency) : ""}</strong></div></div>}</div>}
            <div className="plan-grid">{billing?.plans.map(plan => <article key={plan.id} className={"plan-card" + (plan.id === currentPlanId ? " selected" : "") + (planChoice === plan.id ? " chosen" : "")}>
              <div className="plan-card-head"><div><strong>{plan.name}</strong><small>{plan.description}</small></div><span>{plan.priceLabel}</span></div>
              <ul>{plan.features.map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
              {plan.id === currentPlanId
                ? <span className="plan-current">Текущий тариф</span>
                : <button className="plan-action" onClick={() => writePlanChoice(plan.id)}>{planChoice === plan.id ? "Выбран · оплата скоро" : "Выбрать тариф"}</button>}
            </article>)}</div>
            <p className="billing-disclaimer">Лимиты тарифов предварительные и могут измениться до запуска оплаты.</p>
          </div>}
        </div>
      </div>
    </>}
    {(error || notice) && <div className={error ? "settings-error account-feedback" : "settings-status account-feedback"}>{error || notice}</div>}
  </section>;
}
