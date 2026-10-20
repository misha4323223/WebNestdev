import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";
import { applyPreferences, type UserPreferences } from "../../lib/preferences";
import {
  balanceLabel,
  dateLabel,
  getBilling,
  moneyLabel,
  paymentNotice,
  paymentStatusLabel,
  rubLabel,
  shortDayLabel,
  startCheckout,
  updateAutoRenew,
  type BillingData,
} from "../../lib/billing-api";
import { activePlanId, usePlanChoice, writePlanChoice } from "../../lib/plan-choice";
import { openCookieSettings } from "../legal/CookieConsent";
import { Check, CreditCard, Receipt, RefreshCw, Settings2, ShieldCheck, UserRound, Wallet } from "lucide-react";

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
  const [paying, setPaying] = useState<string | null>(null);
  const [savingRenew, setSavingRenew] = useState(false);
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

  async function pay(plan: "pro" | "team") {
    setPaying(plan); setError(""); setNotice("");
    try {
      const checkout = await startCheckout(plan);
      window.location.assign(checkout.paymentUrl);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPaying(null); }
  }

  async function toggleRenew(autoRenew: boolean) {
    setSavingRenew(true); setError(""); setNotice("");
    try {
      await updateAutoRenew(autoRenew);
      setBilling(await getBilling());
      setNotice(autoRenew ? "Автопродление включено." : "Автопродление выключено: тариф закончится в оплаченную дату.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSavingRenew(false); }
  }

  const nav = [{ id: "account", label: "Аккаунт", icon: UserRound }, { id: "preferences", label: "Предпочтения", icon: Settings2 }, { id: "subscription", label: "Тариф и подписка", icon: CreditCard }] as const;
  const currentPlanId = activePlanId(billing);
  const activePlan = billing?.plans.find(plan => plan.id === currentPlanId);
  const subscription = billing?.subscription;
  const paymentsEnabled = Boolean(billing?.paymentsEnabled);
  const paid = currentPlanId !== "free" && Boolean(subscription?.renewsAt);
  const chosenPlan = planChoice && billing ? billing.plans.find(plan => plan.id === planChoice) : undefined;
  const usageRows = billing ? [
    { label: "Запуски агента", used: billing.usage.agentRuns, limit: billing.limits.agentRunsPerDay },
    { label: "Браузерные проверки", used: billing.usage.browserChecks, limit: billing.limits.browserChecksPerDay },
    { label: "Поиски в интернете", used: billing.usage.webSearches, limit: billing.limits.webSearchesPerDay },
  ] : [];
  const storageLimit = billing?.limits.storageBytes ?? 0;
  const storageUsed = billing?.storage?.usedBytes ?? 0;
  const tokensToday = billing ? billing.cost.promptTokens + billing.cost.completionTokens : 0;
  const historyDays = billing?.history?.days ?? [];
  // Высота столбика — вся активность дня; шкала общая, иначе график сравнивал бы дни между собой нечестно.
  const historyMax = Math.max(1, ...historyDays.map(day => day.agentRuns + day.browserChecks + day.webSearches));
  const weekSpend = historyDays.reduce((sum, day) => sum + (day.costEstimate ?? 0), 0);
  const payments = billing?.payments ?? [];
  return <section className="account-settings settings-panel">
    <div className="panel-title"><div><span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span><strong>Настройки аккаунта</strong></div></div>
    {loading ? <div className="settings-body">Загружаем настройки аккаунта…</div> : <>
      <div className="account-settings-layout">
        <nav className="account-settings-nav">{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setError(""); setNotice(""); }}><Icon size={14}/>{item.label}</button>; })}</nav>
        <div className="account-settings-content">
          {section === "account" && <div className="account-section">
            <span className="eyebrow">ПРОФИЛЬ</span><h3>Профиль</h3><p className="account-muted">Основная информация вашего аккаунта NestDev.</p>
            {account?.user.yandex && <label>Вход через Яндекс ID<input value={"@" + account.user.yandex.login} readOnly/></label>}
            {account?.user.yandex?.email && <label>Email Яндекс ID<input value={account.user.yandex.email ?? ""} readOnly/></label>}
            <label>{account?.user.yandex ? "Служебный адрес аккаунта" : "Email"}<input value={account?.user.email ?? ""} readOnly/></label>
            <label>ID аккаунта<input value={account?.user.id ?? ""} readOnly/></label>
            <label>Дата регистрации<input value={dateLabel(account?.user.createdAt ?? null)} readOnly/></label>
            <div className="account-note"><ShieldCheck size={14}/> {account?.user.yandex ? "Профиль подтверждён через Яндекс ID — данные видны только вам." : "Данные профиля защищены и видны только вам."}</div>
            {/* Документы в личном кабинете: их ищут здесь, а не только в подвале сайта. */}
            <div className="account-legal">
              <span className="eyebrow">ДОКУМЕНТЫ</span>
              <div>
                <a href="/legal/offer" target="_blank" rel="noopener noreferrer">Публичная оферта</a>
                <a href="/legal/terms" target="_blank" rel="noopener noreferrer">Пользовательское соглашение</a>
                <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Политика обработки данных</a>
                <a href="/legal/payments" target="_blank" rel="noopener noreferrer">Оплата и возврат</a>
                <a href="/legal/cookies" target="_blank" rel="noopener noreferrer">Политика cookie</a>
                <a href="/legal/contacts" target="_blank" rel="noopener noreferrer">Реквизиты и контакты</a>
              </div>
            </div>
          </div>}
          {section === "preferences" && <div className="account-section">
            <span className="eyebrow">ПРЕДПОЧТЕНИЯ</span><h3>Предпочтения</h3><p className="account-muted">Параметры сохраняются на сервере и привязаны к вашему аккаунту. Компактный режим применяется сразу.</p>
            <div className="pref-row"><span className="pref-label">Язык интерфейса</span><span className="pref-value">Русский<span className="pref-tag">другие языки позже</span></span></div>
            <label className="account-toggle"><span><strong>Компактный режим</strong><small>Меньше отступов в рабочих панелях — включается мгновенно</small></span><span className="switch"><input type="checkbox" checked={preferences.compactMode} onChange={e => { const next = { ...preferences, compactMode: e.target.checked }; setPreferences(next); applyPreferences(next); }}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <label className="account-toggle is-soon"><span><strong>Email-уведомления<span className="soon-pill">скоро</span></strong><small>Писем пока не отправляем: подключим вместе с почтовым сервисом</small></span><span className="switch"><input type="checkbox" checked={preferences.emailNotifications} disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <label className="account-toggle is-soon"><span><strong>Новости продукта<span className="soon-pill">скоро</span></strong><small>Рассылка обновлений NestDev — тоже после подключения почты</small></span><span className="switch"><input type="checkbox" checked={preferences.productUpdates} disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <p className="account-muted account-legal-note">Рекламные письма отправляются только по отдельному согласию: <a href="/legal/marketing" target="_blank" rel="noopener noreferrer">согласие на рекламные сообщения</a>.</p>
            <div className="account-pref-actions">
              <button type="button" className="ghost-button" onClick={openCookieSettings}>Cookie-настройки</button>
              <button className="send-button account-save" disabled={saving} onClick={() => void savePreferences()}>{saving ? "Сохраняем…" : "Сохранить настройки"}</button>
            </div>
          </div>}
          {section === "subscription" && <div className="account-section billing-section">
            <span className="eyebrow">БИЛЛИНГ</span><h3>Тариф, подписка и расходы</h3>
            <p className="account-muted">{paymentNotice(billing)}</p>
            <div className="billing-cards">
              <article className="billing-card">
                <span className="billing-card-top"><CreditCard size={12}/> Тариф</span>
                <strong>{subscription?.planName ?? activePlan?.name ?? "Бесплатный"}</strong>
                <small>{paid ? "Действует до " + dateLabel(subscription?.renewsAt ?? null) : "Бесплатный тариф действует бессрочно"}</small>
              </article>
              <article className="billing-card">
                <span className="billing-card-top"><Wallet size={12}/> {paid ? "Автопродление" : "Баланс"}</span>
                <strong>{paid ? (subscription?.autoRenew ? "Включено" : "Выключено") : balanceLabel(billing?.balance)}</strong>
                <small>{paid
                  ? subscription?.autoRenew ? "Спишем " + rubLabel(subscription.amountRub) + " " + dateLabel(subscription.renewsAt) : subscription?.recurringAvailable ? "Можно включить в любой момент" : "Услуга периодических платежей не подключена"
                  : "Пополнение не нужно: оплачивается подписка"}</small>
              </article>
              <article className="billing-card">
                <span className="billing-card-top"><Receipt size={12}/> Расходы сегодня</span>
                <strong>{billing?.cost.pricesConfigured ? moneyLabel(billing.cost.costEstimate, billing.cost.currency) : "—"}</strong>
                <small>{billing ? billing.cost.runs + " прогонов · " + tokenLabel(tokensToday) + " токенов" : "—"}</small>
              </article>
            </div>
            {paid && subscription && <div className="account-toggle subscription-renew">
              <span>
                <strong>Автопродление</strong>
                <small>{subscription.autoRenew ? "Следующее списание " + dateLabel(subscription.renewsAt) + " · " + rubLabel(subscription.amountRub) : "Тариф закончится " + dateLabel(subscription.renewsAt) + " и сменится на бесплатный"}</small>
              </span>
              <span className="switch">
                <input type="checkbox" checked={subscription.autoRenew} disabled={savingRenew || (!subscription.autoRenew && !subscription.recurringAvailable)} onChange={event => void toggleRenew(event.target.checked)}/>
                <span className="switch-track"><span className="switch-thumb"/></span>
              </span>
            </div>}
            {chosenPlan && !paymentsEnabled && <div className="plan-choice-note">
              <span>Выбранный тариф · включим вместе с оплатой</span>
              <strong>{chosenPlan.name} · {chosenPlan.priceLabel}</strong>
            </div>}
            <div className="usage-meter-list"><div className="usage-meter-title"><strong>Использование за сегодня</strong><small>Сброс по UTC · {billing?.usage.date ?? ""}</small></div>{usageRows.map(row => <div className="usage-meter" key={row.label}><div><span>{row.label}</span><strong>{row.used} / {row.limit}</strong></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, row.used / Math.max(1, row.limit) * 100)}%` }}/></div><small className="usage-meter-left">{Math.max(0, row.limit - row.used)} осталось</small></div>)}</div>
            {storageLimit > 0 && <div className="usage-meter-list"><div className="usage-meter-title"><strong>Хранилище аккаунта</strong><small>{billing ? (storageUsed / 1024 / 1024).toFixed(1) + " МБ из " + (storageLimit / 1024 / 1024 / 1024).toFixed(1) + " ГБ" : ""}</small></div><div className="usage-meter-track"><span style={{ width: `${Math.min(100, storageUsed / storageLimit * 100)}%` }}/></div></div>}
            <p className="account-muted">Лимит запусков относится к встроенной модели платформы. Со своим AI-провайдером в проекте запуски идут через ваш ключ и модель — без дневной квоты.</p>
            <div className="usage-meter-list"><div className="usage-meter-title"><strong>Последние 7 дней</strong><small>{billing?.cost.pricesConfigured ? moneyLabel(weekSpend, billing.cost.currency) + " за неделю" : "цены модели не заданы"}</small></div>
              <div className="billing-bars">{historyDays.map(day => {
                return <div className="billing-bar" key={day.date} title={shortDayLabel(day.date) + ": " + day.agentRuns + " запусков, " + day.browserChecks + " проверок, " + day.webSearches + " поисков" + (day.costEstimate != null ? ", " + moneyLabel(day.costEstimate, billing?.cost.currency ?? "USD") : "")}>
                  <span className="billing-bar-track">
                    <span className="billing-bar-stack">
                      <span className="billing-seg searches" style={{ height: `${day.webSearches / historyMax * 100}%` }}/>
                      <span className="billing-seg checks" style={{ height: `${day.browserChecks / historyMax * 100}%` }}/>
                      <span className="billing-seg runs" style={{ height: `${day.agentRuns / historyMax * 100}%` }}/>
                    </span>
                  </span>
                  <small>{shortDayLabel(day.date)}</small>
                </div>;
              })}</div>
              <div className="billing-legend"><span><i className="billing-dot runs"/>запуски</span><span><i className="billing-dot checks"/>проверки</span><span><i className="billing-dot searches"/>поиски</span></div>
            </div>
            {billing?.cost.lastRun && <div className="usage-meter-list"><div className="usage-meter-title"><strong>Последний прогон</strong><small>{billing.cost.pricesConfigured ? (billing.cost.exact ? "по данным провайдера" : "оценка по объёму") : "цены не заданы"}</small></div><div className="usage-meter"><div><span>Модель</span><strong>{billing.cost.lastRun.model}</strong></div></div><div className="usage-meter"><div><span>Токены</span><strong>{tokenLabel(billing.cost.lastRun.promptTokens)} вход / {tokenLabel(billing.cost.lastRun.completionTokens)} выход</strong></div></div><div className="usage-meter"><div><span>Стоимость</span><strong>{moneyLabel(billing.cost.lastRun.costEstimate, billing.cost.currency)}</strong></div></div></div>}

            <div className="usage-meter-list">
              <div className="usage-meter-title"><strong>Платежи</strong><small>{payments.length ? payments.length + " за всё время" : "пока пусто"}</small></div>
              {payments.length
                ? <div className="billing-payments">{payments.map(payment => <div className="billing-payment" key={payment.invId}>
                    <div><strong>{payment.planName} · {rubLabel(payment.amount)}</strong><small>Счёт №{payment.invId} · {dateLabel(payment.createdAt)}{payment.kind === "renewal" ? " · продление" : ""}</small></div>
                    <span className={"billing-payment-status " + payment.status}>{paymentStatusLabel(payment.status)}</span>
                  </div>)}</div>
                : <div className="billing-empty"><Receipt size={14}/><div><strong>Платежей пока нет</strong><span>{paymentsEnabled ? "Оплата тарифа появится здесь с номером счёта и датой." : "Оплата ещё не подключена — пополнения и списания появятся позже."}</span></div></div>}
            </div>

            <div className="plan-grid">{billing?.plans.map(plan => <article key={plan.id} className={"plan-card" + (plan.id === currentPlanId ? " selected" : "") + (planChoice === plan.id && plan.id !== currentPlanId ? " chosen" : "")}>
              <div className="plan-card-head"><div><strong>{plan.name}</strong><small>{plan.description}</small></div><span>{plan.priceLabel}</span></div>
              <ul>{plan.features.map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
              {plan.id === "free"
                ? <span className="plan-current">{plan.id === currentPlanId ? "Текущий тариф" : "Входит всегда"}</span>
                : !paymentsEnabled
                  ? <button className="plan-action" onClick={() => writePlanChoice(plan.id)}>{planChoice === plan.id ? "Выбран · оплата скоро" : "Выбрать тариф"}</button>
                  : <button className="plan-action" disabled={paying !== null} onClick={() => void pay(plan.id as "pro" | "team")}>
                      {paying === plan.id ? <><RefreshCw size={12} className="spin"/> Открываем…</> : <>{plan.id === currentPlanId ? "Продлить" : "Оплатить"} {plan.priceLabel}</>}
                    </button>}
            </article>)}</div>
            <p className="billing-disclaimer">Оплата принимается картой РФ и через СБП. Чек самозанятого приходит через «Мой налог».</p>
          </div>}
        </div>
      </div>
    </>}
    {(error || notice) && <div className={error ? "settings-error account-feedback" : "settings-status account-feedback"}>{error || notice}</div>}
  </section>;
}
