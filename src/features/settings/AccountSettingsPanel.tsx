import { useEffect, useState, type FormEvent } from "react";
import { apiJson } from "../../lib/api";
import { logoutAll } from "../../lib/auth-api";
import { applyPreferences, type UserPreferences } from "../../lib/preferences";
import {
  balanceLabel,
  bytesLabel,
  dateLabel,
  getBilling,
  moneyLabel,
  paymentNotice,
  paymentStatusLabel,
  refreshStorage,
  rubLabel,
  shortDayLabel,
  updateAutoRenew,
  type BillingData,
  type PlanId,
} from "../../lib/billing-api";
import { activePlanId, usePlanChoice } from "../../lib/plan-choice";
import { contactEmailOf } from "../../lib/account-contact";
import { updateOnboardingProfile, type OnboardingProfile } from "../../lib/onboarding";
import { PlanDetail } from "../billing/PlanDetail";
import { openCookieSettings } from "../legal/CookieConsent";
import { ArrowLeft, ArrowRight, Check, CreditCard, LogOut, Receipt, RefreshCw, Settings2, ShieldCheck, UserRound, Wallet } from "lucide-react";

type Preferences = UserPreferences;
type AccountData = {
  user: { id: string; email: string; phone?: string; createdAt: string; yandex?: { login: string; email: string | null } };
  profile: OnboardingProfile | null;
  preferences: Preferences;
};

const initialPreferences: Preferences = { language: "ru", compactMode: false, emailNotifications: true, productUpdates: false };
const tokenLabel = (value: number) => value.toLocaleString("ru-RU");
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

/**
 * Подписка на рассылку в настройках: пока человек не подписан — одна кнопка, по ней раскрываются
 * почта, согласие и «Подписать». У подписанных на том же месте стоит «Отписаться», чтобы не искать
 * отмену в другом разделе или только в письме.
 */
function NewsletterCard({ profile, knownEmail, onProfile }: {
  profile: OnboardingProfile | null;
  knownEmail: string;
  onProfile: (profile: OnboardingProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"subscribe" | "unsubscribe" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const subscribed = Boolean(profile?.productUpdates);
  const address = profile?.email?.trim() || knownEmail;

  function start() {
    setEmail(address);
    setConsent(false);
    setError("");
    setNotice("");
    setOpen(true);
  }

  async function subscribe(event: FormEvent) {
    event.preventDefault();
    const value = email.trim();
    if (!validEmail(value)) { setError("Проверьте адрес почты"); return; }
    if (!consent) { setError("Отметьте согласие на рекламные письма"); return; }
    setBusy("subscribe"); setError(""); setNotice("");
    try {
      onProfile(await updateOnboardingProfile({ email: value, productUpdates: true }));
      setOpen(false);
      setConsent(false);
      setNotice("Готово: письма будут приходить на " + value + ".");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подписаться");
    } finally { setBusy(null); }
  }

  async function unsubscribe() {
    setBusy("unsubscribe"); setError(""); setNotice("");
    try {
      onProfile(await updateOnboardingProfile({ productUpdates: false }));
      setNotice("Вы отписаны: рекламные письма больше не придут.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отписаться");
    } finally { setBusy(null); }
  }

  return <div className="account-subscribe">
    <div className="account-subscribe-head">
      <div>
        <strong>Рассылка NestDev</strong>
        <small>Новости продукта, обновления, тарифы и акции. Рекламные письма приходят только по согласию.</small>
      </div>
      {subscribed
        ? <span className="account-subscribe-state"><Check size={10}/> Вы подписаны</span>
        : open
          ? null
          : <button type="button" className="send-button account-subscribe-open" disabled={!profile || busy !== null} onClick={start}>Подписаться</button>}
    </div>

    {subscribed
      ? <div className="account-subscribe-actions">
          <span className="account-subscribe-note">Письма приходят на {address || "указанную почту"}.</span>
          <button type="button" className="ghost-button" disabled={busy !== null} onClick={() => void unsubscribe()}>
            {busy === "unsubscribe" ? "Отписываем…" : "Отписаться"}
          </button>
          {!address && <span className="account-subscribe-error">В профиле нет почты — письма не смогут приходить. Укажите её в разделе «Аккаунт».</span>}
        </div>
      : open
        ? <form className="account-subscribe-form" onSubmit={event => void subscribe(event)}>
            <label className="account-subscribe-field">
              <span>Email для рассылки</span>
              <input type="email" value={email} maxLength={200} inputMode="email" autoComplete="email"
                onChange={event => { setEmail(event.target.value); setError(""); }} placeholder="you@example.com" />
            </label>
            <label className="account-subscribe-check">
              <input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); setError(""); }}/>
              <span>Согласен(на) получать рекламные и информационные письма NestDev. Не условие регистрации, отозвать можно в любой момент. <a href="/legal/marketing" target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>Условия согласия</a>.</span>
            </label>
            {error && <div className="account-subscribe-error" role="alert">{error}</div>}
            <div className="account-subscribe-actions">
              <button type="submit" className="send-button account-subscribe-submit" disabled={busy !== null || !consent || !email.trim()}>
                {busy === "subscribe" ? "Подписываем…" : "Подписать"}
              </button>
              <button type="button" className="ghost-button" disabled={busy !== null} onClick={() => { setOpen(false); setError(""); }}>Отмена</button>
            </div>
          </form>
        : null}

    {!profile && <p className="account-subscribe-note">Сначала закончите знакомство — почта и согласие сохраняются в профиле.</p>}
    {subscribed && error && <div className="account-subscribe-error" role="alert">{error}</div>}
    {notice && <p className="account-subscribe-note account-subscribe-done">{notice}</p>}
  </div>;
}

export function AccountSettingsPanel() {
  const [section, setSection] = useState<"account" | "preferences" | "security" | "subscription">("account");
  const [account, setAccount] = useState<AccountData | null>(null);
  const [preferences, setPreferences] = useState<UserPreferences>(initialPreferences);
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Контакты и согласие сохраняются отдельно от настроек интерфейса: это профиль, а не тема.
  const [profileDraft, setProfileDraft] = useState({ name: "", email: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingRenew, setSavingRenew] = useState(false);
  // Выбор карточки в настройках открывает тот же компактный экран тарифа, что и на главной.
  const [planDetailId, setPlanDetailId] = useState<PlanId | null>(null);
  // The chosen plan is shared state: it is the plan the user wants to move to, so the
  // settings screen names it exactly like the home rail and the top bar do.
  const planChoice = usePlanChoice();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshingStorage, setRefreshingStorage] = useState(false);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);

  async function reload() {
    setLoading(true); setError("");
    try {
      const [accountData, billingData] = await Promise.all([apiJson<AccountData>("/api/account/settings"), getBilling()]);
      setAccount(accountData); setPreferences(accountData.preferences); setBilling(billingData); applyPreferences(accountData.preferences);
      setProfileDraft({
        name: accountData.profile?.name ?? "",
        email: accountData.profile?.email || contactEmailOf({
          accountEmail: accountData.user.email,
          yandexEmail: accountData.user.yandex?.email,
        }),
      });
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

  /** Один источник правды после любой правки профиля: карточка настроек и черновик полей. */
  function applyProfile(profile: OnboardingProfile) {
    setAccount(current => current ? { ...current, profile } : current);
    setProfileDraft({ name: profile.name, email: profile.email });
  }

  /** Имя и почта — те же поля, что в знакомстве; правка не сдвигает дату знакомства. */
  async function saveProfile() {
    if (!account?.profile) { setError("Профиль ещё не заполнен: закончите знакомство."); return; }
    const name = profileDraft.name.trim();
    const email = profileDraft.email.trim();
    if (name.length < 2) { setError("Имя должно быть хотя бы из двух символов"); return; }
    if (email && !validEmail(email)) { setError("Проверьте адрес почты"); return; }
    setSavingProfile(true); setError(""); setNotice("");
    try {
      applyProfile(await updateOnboardingProfile({ name, email }));
      setNotice("Контакты сохранены.");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSavingProfile(false); }
  }

  /**
   * Отзыв всех сессий. После ответа текущая cookie уже недействительна, поэтому остаётся
   * только перезагрузить страницу: панель сама покажет экран входа.
   */
  async function signOutEverywhere() {
    setSigningOutEverywhere(true); setError(""); setNotice("");
    try {
      await logoutAll();
      setNotice("Все входы завершены. Открываем экран входа…");
      window.setTimeout(() => window.location.reload(), 500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSigningOutEverywhere(false);
    }
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

  const nav = [{ id: "account", label: "Аккаунт", icon: UserRound }, { id: "security", label: "Безопасность", icon: ShieldCheck }, { id: "preferences", label: "Предпочтения", icon: Settings2 }, { id: "subscription", label: "Тариф и подписка", icon: CreditCard }] as const;
  const currentPlanId = activePlanId(billing);
  const activePlan = billing?.plans.find(plan => plan.id === currentPlanId);
  const subscription = billing?.subscription;
  const paymentsEnabled = Boolean(billing?.paymentsEnabled);
  const paid = currentPlanId !== "free" && Boolean(subscription?.renewsAt);
  const chosenPlan = planChoice && billing ? billing.plans.find(plan => plan.id === planChoice) : undefined;
  const selectedPlan = planDetailId ? billing?.plans.find(plan => plan.id === planDetailId) : undefined;
  // Поиск в интернете — инструмент внутри запуска агента, а не отдельная шкала расхода: его
  // дневная квота остаётся на сервере, но в интерфейсе не показывается.
  const usageRows = billing ? [
    { label: "Запуски агента", used: billing.usage.agentRuns, limit: billing.limits.agentRunsPerDay },
    { label: "Браузерные проверки", used: billing.usage.browserChecks, limit: billing.limits.browserChecksPerDay },
  ] : [];
  const storageLimit = billing?.limits.storageBytes ?? 0;
  const storageUsed = billing?.storage?.usedBytes ?? 0;
  const storage = billing?.storage;
  // Порог считает сервер; локальная копия нужна только для старых ответов без `state`.
  const storageState = storage?.state ?? (storageLimit > 0
    ? (storageUsed >= storageLimit ? "full" : storageUsed >= storageLimit * 0.8 ? "warning" : "ok")
    : "ok");
  const storagePercent = storageLimit > 0 ? Math.min(100, Math.round(storageUsed / storageLimit * 100)) : 0;
  const storageProjects = storage?.projects ?? [];
  // В карточке видны самые крупные проекты: список из пятидесяти строк читать никто не будет,
  // а полный размер по каждому всё равно приходит с сервера.
  const visibleStorageProjects = storageProjects.slice(0, 6);
  const storageMeasuredAt = storage?.measuredAt
    ? new Date(storage.measuredAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
  const refreshStorageSize = async () => {
    setRefreshingStorage(true);
    setError("");
    setNotice("");
    try {
      const result = await refreshStorage();
      setBilling(current => current ? { ...current, storage: result.storage } : current);
      setNotice("Размер хранилища пересчитан: " + bytesLabel(result.storage.usedBytes));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setRefreshingStorage(false);
    }
  };
  const tokensToday = billing ? billing.cost.promptTokens + billing.cost.completionTokens : 0;
  const historyDays = billing?.history?.days ?? [];
  // Высота столбика — вся активность дня; шкала общая, иначе график сравнивал бы дни между собой нечестно.
  const historyMax = Math.max(1, ...historyDays.map(day => day.agentRuns + day.browserChecks));
  const weekSpend = historyDays.reduce((sum, day) => sum + (day.costEstimate ?? 0), 0);
  const payments = billing?.payments ?? [];
  const profile = account?.profile ?? null;
  // Телефон и почта — разные строки: служебный адрес …@phone.webnestdev.local не показывается,
  // почта берётся из контактов знакомства (или настоящего адреса входа / Яндекс ID).
  const accountPhone = account?.user.phone ?? "";
  const contactEmail = contactEmailOf({
    profileEmail: profile?.email,
    accountEmail: account?.user.email,
    yandexEmail: account?.user.yandex?.email,
  });
  return <section className="account-settings settings-panel">
    <div className="panel-title"><div><span className="eyebrow">ЛИЧНЫЙ КАБИНЕТ</span><strong>Настройки аккаунта</strong></div></div>
    {loading ? <div className="settings-body">Загружаем настройки аккаунта…</div> : <>
      <div className="account-settings-layout">
        <nav className="account-settings-nav">{nav.map(item => { const Icon = item.icon; return <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => { setSection(item.id); setPlanDetailId(null); setError(""); setNotice(""); }}><Icon size={14}/>{item.label}</button>; })}</nav>
        <div className="account-settings-content">
          {section === "account" && <div className="account-section">
            <span className="eyebrow">ПРОФИЛЬ</span><h3>Профиль</h3><p className="account-muted">Основная информация вашего аккаунта NestDev.</p>
            <label>Имя<input value={profileDraft.name} placeholder="Как к вам обращаться" maxLength={80} onChange={event => setProfileDraft(current => ({ ...current, name: event.target.value }))}/></label>
            <label>Email для связи<input type="email" value={profileDraft.email} placeholder="Можно не заполнять" maxLength={200} inputMode="email" autoComplete="email" onChange={event => setProfileDraft(current => ({ ...current, email: event.target.value }))}/></label>
            <div className="account-pref-actions account-profile-actions">
              <button className="send-button account-save" disabled={savingProfile || !profile} onClick={() => void saveProfile()}>{savingProfile ? "Сохраняем…" : "Сохранить контакты"}</button>
            </div>
            {!profile && <p className="account-muted">Профиль ещё не заполнен — контакты появятся после знакомства.</p>}
            {accountPhone && <label>Телефон<input value={accountPhone} readOnly/></label>}
            {account?.user.yandex && <label>Вход через Яндекс ID<input value={"@" + account.user.yandex.login} readOnly/></label>}
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
          {section === "security" && <div className="account-section">
            <span className="eyebrow">БЕЗОПАСНОСТЬ</span><h3>Сессии и входы</h3>
            <p className="account-muted">Вход открывает сессию в браузере. Она завершается после долгого бездействия и по абсолютному сроку — сервер проверяет это при каждом запросе.</p>
            <div className="account-note"><ShieldCheck size={14}/> Если вы входили на чужом устройстве или потеряли доступ к нему, завершите все сессии сразу.</div>
            <div className="account-pref-actions">
              <button type="button" className="ghost-button" disabled={signingOutEverywhere} onClick={() => void signOutEverywhere()}>
                <LogOut size={13}/> {signingOutEverywhere ? "Завершаем…" : "Выйти на всех устройствах"}
              </button>
            </div>
            <p className="account-muted account-legal-note">Кнопка завершает все входы аккаунта, включая этот. Понадобится войти заново.</p>
          </div>}
          {section === "preferences" && <div className="account-section">
            <span className="eyebrow">ПРЕДПОЧТЕНИЯ</span><h3>Предпочтения</h3><p className="account-muted">Параметры сохраняются на сервере и привязаны к вашему аккаунту. Компактный режим применяется сразу.</p>
            <div className="pref-row"><span className="pref-label">Язык интерфейса</span><span className="pref-value">Русский<span className="pref-tag">другие языки позже</span></span></div>
            <label className="account-toggle"><span><strong>Компактный режим</strong><small>Меньше отступов в рабочих панелях — включается мгновенно</small></span><span className="switch"><input type="checkbox" checked={preferences.compactMode} onChange={e => { const next = { ...preferences, compactMode: e.target.checked }; setPreferences(next); applyPreferences(next); }}/><span className="switch-track"><span className="switch-thumb"/></span></span></label>
            <NewsletterCard profile={profile} knownEmail={profileDraft.email || contactEmail} onProfile={applyProfile}/>
            <p className="account-muted account-legal-note">Служебные письма (оплата, продление, ответ поддержки) приходят всегда. Рекламные — только по отдельному согласию: <a href="/legal/marketing" target="_blank" rel="noopener noreferrer">согласие на рекламные сообщения</a>.</p>
            <div className="account-pref-actions">
              <button type="button" className="ghost-button" onClick={openCookieSettings}>Cookie-настройки</button>
              <button className="send-button account-save" disabled={saving} onClick={() => void savePreferences()}>{saving ? "Сохраняем…" : "Сохранить настройки"}</button>
            </div>
          </div>}
          {section === "subscription" && (planDetailId && billing && selectedPlan
            ? <div className="account-section billing-section">
                <button type="button" className="ghost-button plan-detail-back" onClick={() => setPlanDetailId(null)}><ArrowLeft size={13}/> Все тарифы</button>
                <div className="plan-detail-shell account-plan-detail">
                  <PlanDetail key={selectedPlan.id} plan={selectedPlan} billing={billing} active={selectedPlan.id === currentPlanId}/>
                </div>
              </div>
            : <div className="account-section billing-section">
            <span className="eyebrow">БИЛЛИНГ</span><h3>Тариф, подписка и расходы</h3>
            <p className="account-muted">{paymentNotice(billing)}</p>
            <div className="billing-cards">
              <article className="billing-card">
                <span className="billing-card-top"><CreditCard size={12}/> Тариф</span>
                <strong>{subscription?.planName ?? activePlan?.name ?? "Старт"}</strong>
                <small>{paid ? "Действует до " + dateLabel(subscription?.renewsAt ?? null) : "Тариф «Старт» действует бессрочно"}</small>
              </article>
              <article className="billing-card">
                <span className="billing-card-top"><Wallet size={12}/> {paid ? "Автопродление" : "Баланс"}</span>
                <strong>{paid ? (subscription?.autoRenew ? "Включено" : "Выключено") : balanceLabel(billing?.balance)}</strong>
                <small>{paid
                  ? subscription?.autoRenew ? "Спишем " + rubLabel(subscription.amountRub) + " " + dateLabel(subscription.renewsAt) : subscription?.recurringAvailable ? "Можно включить в любой момент" : "Продлить можно вручную после окончания"
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
            {storageLimit > 0 && <div className={"usage-meter-list storage-card " + storageState}>
              <div className="usage-meter-title"><strong>Хранилище аккаунта</strong><small>{bytesLabel(storageUsed)} из {bytesLabel(storageLimit)} · {storagePercent}%</small></div>
              <div className={"usage-meter-track storage-track " + storageState} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={storagePercent} aria-label="Хранилище аккаунта"><span style={{ width: `${storagePercent}%` }}/></div>
              {storageState !== "ok" && <p className={"storage-note " + storageState}>{storageState === "full"
                ? "Лимит исчерпан: агент не сможет писать файлы, пока место не освободится. Удалите файлы проекта или смените тариф."
                : "Осталось " + bytesLabel(Math.max(0, storageLimit - storageUsed)) + ". Освободите место или смените тариф, чтобы агент не остановился на середине задачи."}</p>}
              <div className="storage-projects">
                <div className="storage-projects-head">
                  <strong>Проекты</strong>
                  <button type="button" className="ghost-button storage-refresh" onClick={() => void refreshStorageSize()} disabled={refreshingStorage}>
                    <RefreshCw size={11} className={refreshingStorage ? "spin" : ""}/> {refreshingStorage ? "Считаем…" : "Пересчитать"}
                  </button>
                </div>
                {visibleStorageProjects.length > 0
                  ? visibleStorageProjects.map(project => <div className="storage-project" key={project.id}>
                      <span className="storage-project-name" title={project.name}>{project.name}</span>
                      <span className="storage-project-size">{bytesLabel(project.sizeBytes)}</span>
                      <span className="storage-project-share" title="Доля квоты аккаунта">{storageLimit > 0 ? Math.round(project.sizeBytes / storageLimit * 100) : 0}%</span>
                    </div>)
                  : <p className="storage-empty">Проектов пока нет — размер появится после первого файла.</p>}
                {storageProjects.length > visibleStorageProjects.length && <p className="storage-empty">и ещё {storageProjects.length - visibleStorageProjects.length} проектов</p>}
              </div>
              <p className="storage-hint">В размер входят все файлы проекта, включая зависимости и сборки.{storageMeasuredAt ? " Обновлено " + storageMeasuredAt + "." : ""} Сверка повторяется раз в сутки.</p>
            </div>}
            <p className="account-muted">Лимит запусков относится к встроенной модели платформы. Со своим AI-провайдером в проекте запуски идут через ваш ключ и модель — без дневной квоты.</p>
            <div className="usage-meter-list"><div className="usage-meter-title"><strong>Последние 7 дней</strong><small>{billing?.cost.pricesConfigured ? moneyLabel(weekSpend, billing.cost.currency) + " за неделю" : "цены модели не заданы"}</small></div>
              <div className="billing-bars">{historyDays.map(day => {
                return <div className="billing-bar" key={day.date} title={shortDayLabel(day.date) + ": " + day.agentRuns + " запусков, " + day.browserChecks + " проверок" + (day.costEstimate != null ? ", " + moneyLabel(day.costEstimate, billing?.cost.currency ?? "USD") : "")}>
                  <span className="billing-bar-track">
                    <span className="billing-bar-stack">
                      <span className="billing-seg checks" style={{ height: `${day.browserChecks / historyMax * 100}%` }}/>
                      <span className="billing-seg runs" style={{ height: `${day.agentRuns / historyMax * 100}%` }}/>
                    </span>
                  </span>
                  <small>{shortDayLabel(day.date)}</small>
                </div>;
              })}</div>
              <div className="billing-legend"><span><i className="billing-dot runs"/>запуски</span><span><i className="billing-dot checks"/>проверки</span></div>
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

            <div className="plan-grid">{billing?.plans.map(plan => <button
              type="button"
              key={plan.id}
              className={"plan-card plan-card-select" + (plan.id === currentPlanId ? " selected" : "") + (planChoice === plan.id && plan.id !== currentPlanId ? " chosen" : "")}
              onClick={() => setPlanDetailId(plan.id)}
              aria-label={"Открыть описание тарифа «" + plan.name + "»"}
            >
              <div className="plan-card-head"><div><strong>{plan.name}</strong><small>{plan.description}</small></div><span className="plan-card-price">{Boolean(plan.discountPercent)&&<s>{plan.basePriceLabel}</s>}<b>{plan.priceLabel}</b></span></div>
              <ul>{plan.features.slice(0, 4).map(feature => <li key={feature}><Check size={12}/>{feature}</li>)}</ul>
              <span className="plan-card-open">{plan.id === currentPlanId ? "Текущий тариф" : "Описание и оплата"} <ArrowRight size={12}/></span>
            </button>)}</div>
            <p className="billing-disclaimer">Оплата принимается картой РФ и через СБП.</p>
          </div>)}
        </div>
      </div>
    </>}
    {(error || notice) && <div className={error ? "settings-error account-feedback" : "settings-status account-feedback"}>{error || notice}</div>}
  </section>;
}
