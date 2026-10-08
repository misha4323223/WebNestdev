import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";
import { requestPhoneLinkCode, verifyPhoneLinkCode } from "../../lib/auth-api";
import { Check, CreditCard, Settings2, ShieldCheck, Sparkles, UserRound } from "lucide-react";

type Preferences = { language: "ru" | "en"; compactMode: boolean; emailNotifications: boolean; productUpdates: boolean };
type Plan = { id: "free" | "pro" | "team"; name: string; priceLabel: string; description: string; limits: { projects: number; agentRunsPerDay: number; browserChecksPerDay: number }; features: string[] };
type Subscription = { plan: "free" | "pro" | "team"; status: "free" | "demo_active" | "demo_expired" | "demo_cancelled"; startedAt: string | null; expiresAt: string | null; updatedAt: string; mode: "demo" };
type AccountData = { user: { id: string; email: string; phone: string | null; createdAt: string }; preferences: Preferences };
type Usage = { date: string; agentRuns: number; browserChecks: number };
type BillingData = { mode: "demo"; subscription: Subscription; plans: Plan[]; limits: Plan["limits"]; usage: Usage };

const initialPreferences: Preferences = { language: "ru", compactMode: false, emailNotifications: true, productUpdates: false };
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "—";

export function AccountSettingsPanel() {
  const [section, setSection] = useState<"account" | "preferences" | "subscription">("account");
  const [account, setAccount] = useState<AccountData | null>(null);
  const [preferences, setPreferences] = useState<Preferences>(initialPreferences);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyPlan, setBusyPlan] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [linkPhone, setLinkPhone] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [phoneCodeRequested, setPhoneCodeRequested] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneConsent, setPhoneConsent] = useState(false);

  async function reload() {
    setLoading(true); setError("");
    try {
      const [accountData, billingData] = await Promise.all([apiJson<AccountData>("/api/account/settings"), apiJson<BillingData>("/api/billing")]);
      setAccount(accountData); setPreferences(accountData.preferences); setBilling(billingData);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);

  async function savePreferences() {
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await apiJson<{ preferences: Preferences }>("/api/account/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(preferences) });
      setPreferences(result.preferences); setNotice("Настройки сохранены.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  async function requestPhoneLink() {
    if (!phoneConsent) { setError("Подтвердите согласие на обработку номера телефона."); return; }
    setPhoneBusy(true); setError(""); setNotice("");
    try {
      await requestPhoneLinkCode(linkPhone, phoneConsent);
      setPhoneCodeRequested(true);
      setNotice("Если номер корректен, SMS-код отправлен. Код действует 5 минут.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPhoneBusy(false); }
  }
  async function confirmPhoneLink() {
    setPhoneBusy(true); setError(""); setNotice("");
    try {
      await verifyPhoneLinkCode(linkPhone, linkCode);
      setPhoneCodeRequested(false); setLinkCode(""); setLinkPhone("");
      await reload(); setNotice("Номер телефона подтверждён. Повторно привязать его к другому аккаунту нельзя.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPhoneBusy(false); }
  }

  async function activate(plan: "pro" | "team") {
    setBusyPlan(plan); setError(""); setNotice("");
    try {
      await apiJson("/api/billing/demo/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) });
      await reload(); setNotice("Демо-тариф активирован на 30 дней. Оплата не выполнялась.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyPlan(""); }
  }
  async function cancelDemo() {
    setBusyPlan("cancel"); setError(""); setNotice("");
    try {
      await apiJson("/api/billing/demo/cancel", { method: "POST" });
      await reload(); setNotice("Демо-подписка отменена. Платежей не было.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusyPlan(""); }
  }

  const nav = [{ id: "account", label: "Аккаунт", icon: UserRound }, { id: "preferences", label: "Предпочтения", icon: Settings2 }, { id: "subscription", label: "Тариф и подписка", icon: CreditCard }] as const;
  const activePlan = billing?.plans.find(plan => plan.id === billing.subscription.plan);
  const usageRows = billing ? [
    { label: "Запуски агента", used: billing.usage.agentRuns, limit: billing.limits.agentRunsPerDay },
    { label: "Браузерные проверки", used: billing.usage.browserChecks, limit: billing.limits.browserChecksPerDay },
  ] : [];
  return <section className="account-settings settings-panel">
    <div className="panel-title"><div><span className="eyebrow">ACCOUNT CENTER</span><strong>Настройки аккаунта</strong></div><span className="demo-pill"><ShieldCheck size={12}/> DEMO MODE</span></div>
    {loading ? <div className="settings-body">Загружаем настройки аккаунта…</div> : <>
      <div className="account-settings-layout">
        <nav className="account-settings-nav">{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setError(""); setNotice(""); }}><Icon size={14}/>{item.label}</button>; })}</nav>
        <div className="account-settings-content">
          {section === "account" && <div className="account-section">
            <span className="eyebrow">PROFILE</span><h3>Профиль</h3><p className="account-muted">Основная информация вашего аккаунта WebNestdev.</p>
            {account?.user.email && <label>Email<input value={account.user.email} readOnly/></label>}
            <label>Телефон<input value={account?.user.phone ?? "Не подтверждён"} readOnly/></label>
            {!account?.user.phone && <div className="phone-link-form">
              <p className="account-muted">Подтвердите номер, чтобы защитить аккаунт и получить право на демо-тариф. Один номер можно привязать только к одному аккаунту.</p>
              <label>Российский номер<input type="tel" value={linkPhone} onChange={event => setLinkPhone(event.target.value)} placeholder="+7 900 123-45-67" disabled={phoneCodeRequested}/></label>
              {phoneCodeRequested && <label>Код из SMS<input type="text" inputMode="numeric" autoComplete="one-time-code" value={linkCode} onChange={event => setLinkCode(event.target.value.replace(/\\D/g, "").slice(0, 6))} placeholder="000000" maxLength={6}/></label>}
              <label className="phone-consent"><input type="checkbox" checked={phoneConsent} onChange={event => setPhoneConsent(event.target.checked)}/><span>Согласен на обработку номера для входа, защиты аккаунта и ограничения повторного демо.</span></label>
              {!phoneCodeRequested ? <button className="send-button account-save" disabled={phoneBusy || !linkPhone.trim()} onClick={() => void requestPhoneLink()}>{phoneBusy ? "Отправляем…" : "Подтвердить телефон"}</button> : <div className="phone-link-actions"><button className="send-button account-save" disabled={phoneBusy || linkCode.length !== 6} onClick={() => void confirmPhoneLink()}>{phoneBusy ? "Проверяем…" : "Подтвердить код"}</button><button className="ghost-button" disabled={phoneBusy} onClick={() => {setPhoneCodeRequested(false);setLinkCode("");}}>Изменить номер</button></div>}
            </div>}
            <label>ID аккаунта<input value={account?.user.id ?? ""} readOnly/></label>
            <label>Дата регистрации<input value={dateLabel(account?.user.createdAt ?? null)} readOnly/></label>
            <div className="account-note"><ShieldCheck size={14}/> Данные аккаунта доступны только после авторизации.</div>
          </div>}
          {section === "preferences" && <div className="account-section">
            <span className="eyebrow">PREFERENCES</span><h3>Предпочтения</h3><p className="account-muted">Параметры сохраняются на сервере и привязаны к вашему аккаунту.</p>
            <label>Язык интерфейса<select value={preferences.language} onChange={e => setPreferences({ ...preferences, language: e.target.value as Preferences["language"] })}><option value="ru">Русский</option><option value="en">English</option></select></label>
            <label className="account-toggle"><span><strong>Компактный режим</strong><small>Меньше отступов в рабочих панелях</small></span><input type="checkbox" checked={preferences.compactMode} onChange={e => setPreferences({ ...preferences, compactMode: e.target.checked })}/></label>
            <label className="account-toggle"><span><strong>Email-уведомления</strong><small>Уведомления аккаунта (отправка писем пока не подключена)</small></span><input type="checkbox" checked={preferences.emailNotifications} onChange={e => setPreferences({ ...preferences, emailNotifications: e.target.checked })}/></label>
            <label className="account-toggle"><span><strong>Новости продукта</strong><small>Обновления WebNestdev (демо-настройка)</small></span><input type="checkbox" checked={preferences.productUpdates} onChange={e => setPreferences({ ...preferences, productUpdates: e.target.checked })}/></label>
            <button className="send-button account-save" disabled={saving} onClick={() => void savePreferences()}>{saving ? "Сохраняем…" : "Сохранить настройки"}</button>
          </div>}
          {section === "subscription" && <div className="account-section">
            <span className="eyebrow">SUBSCRIPTION</span><h3>Тариф и подписка</h3>
            <div className="subscription-current"><div><span>Текущий тариф</span><strong>{activePlan?.name ?? "Free"}</strong></div><span className="demo-pill"><Sparkles size={12}/> Только демо</span></div>
            <p className="account-muted">{billing?.subscription.status === "demo_active" ? `Демо действует до ${dateLabel(billing.subscription.expiresAt)}.` : billing?.subscription.status === "demo_cancelled" ? "Демо-подписка отменена." : billing?.subscription.status === "demo_expired" ? "Срок демо закончился. Доступен Free." : "Бесплатный режим активен. Можно включить демо-тариф на 30 дней."}</p>
            <div className="usage-meter-list"><div className="usage-meter-title"><strong>Использование за сегодня</strong><small>Сброс по UTC · ${billing?.usage.date ?? ""}</small></div>{usageRows.map(row => <div className="usage-meter" key={row.label}><div><span>{row.label}</span><strong>{row.used} / {row.limit}</strong></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, row.used / Math.max(1, row.limit) * 100)}%` }}/></div></div>)}</div>
            <div className="plan-grid">{billing?.plans.map(plan => <article key={plan.id} className={"plan-card" + (plan.id === billing.subscription.plan ? " selected" : "")}>
              <div className="plan-card-head"><div><strong>{plan.name}</strong><small>{plan.description}</small></div><span>{plan.priceLabel}</span></div>
              <ul>{plan.features.map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
              {plan.id === "free" ? <span className="plan-current">{billing.subscription.plan === "free" ? "Текущий тариф" : "Бесплатный тариф"}</span> : <button className="plan-action" disabled={Boolean(busyPlan) || billing.subscription.plan === plan.id && billing.subscription.status === "demo_active"} onClick={() => void activate(plan.id as "pro" | "team")}>{busyPlan === plan.id ? "Активируем…" : billing.subscription.plan === plan.id && billing.subscription.status === "demo_active" ? "Активен (демо)" : "Попробовать 30 дней"}</button>}
            </article>)}</div>
            {billing?.subscription.status === "demo_active" && <button className="ghost-button account-cancel-demo" disabled={Boolean(busyPlan)} onClick={() => void cancelDemo()}>{busyPlan === "cancel" ? "Отменяем…" : "Отменить демо-подписку"}</button>}
            <p className="billing-disclaimer">Демо-режим: платежи, банковские карты и реальные списания отключены. Тарифы пока демонстрационные.</p>
          </div>}
        </div>
      </div>
    </>}
    {(error || notice) && <div className={error ? "settings-error account-feedback" : "settings-status account-feedback"}>{error || notice}</div>}
  </section>;
}
