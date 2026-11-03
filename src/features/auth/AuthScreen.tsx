import { useEffect, useState, type FormEvent } from "react";
import { getVkAuthStatus, getYandexAuthStatus, startPhoneLogin, verifyPhoneLogin, type VkAuthStatus, type YandexAuthStatus } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";
import { openCookieSettings } from "../legal/CookieConsent";
import { legalPath } from "../../lib/legal";

/** Правовые ссылки стоят до отправки кода: согласие даётся осознанно, а не после SMS. */
const RESEND_SECONDS = 45;
/** Арт для правой половины десктопного входа: на телефоне он скрыт, там важнее форма. */
const AUTH_ART = "/brand/file_000000005ed481f4a60f669dea9ef0ed.webp";

/**
 * What the Yandex callback puts in `?yandex_login=…`. A successful return never shows
 * this screen (the session already exists), so every text here is a failure with a
 * next step: "не удалось" without a reason is exactly what makes an OAuth setup hard.
 */
const vkNotices: Record<string, string> = {
  ok: "VK подтвердил вход, но сессия не сохранилась. Разрешите cookie для сайта и попробуйте ещё раз.",
  denied: "Вы отменили вход через VK ID.",
  not_configured: "Вход через VK ID временно недоступен. Используйте вход по SMS.",
  state_expired: "Ссылка входа через VK ID устарела. Нажмите кнопку ещё раз.",
  token_error: "VK ID не выдал токен входа. Проверьте Redirect URL и тип приложения в кабинете VK ID.",
  profile_error: "VK ID не отдал профиль. Проверьте доступ к личным данным в настройках приложения.",
  error: "Не удалось завершить вход через VK ID.",
  blocked: "Аккаунт заблокирован администратором. Напишите в поддержку.",
};

const yandexNotices: Record<string, string> = {
  // Reaching this screen with `ok` means the session cookie did not stick, otherwise
  // AuthGate would already be showing the app.
  ok: "Яндекс подтвердил вход, но сессия не сохранилась. Разрешите cookie для сайта и попробуйте ещё раз.",
  denied: "Вы отменили вход через Яндекс ID.",
  not_configured: "Вход через Яндекс ID временно недоступен. Используйте вход по SMS.",
  state_expired: "Ссылка входа через Яндекс ID устарела. Нажмите кнопку ещё раз.",
  token_error: "Яндекс не выдал токен входа. Попробуйте ещё раз.",
  profile_error: "Яндекс ID не отдал профиль. В приложении на oauth.yandex.ru должно быть включено право «Доступ к логину, имени и фамилии, полу» (login:info).",
  error: "Не удалось завершить вход через Яндекс ID.",
  blocked: "Аккаунт заблокирован администратором. Напишите в поддержку.",
};

export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"number" | "code">("number");
  // Signing in by number needs an explicit consent to process it.
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  // Что сервер говорит о доставке кода: тестовый режим или отсутствие провайдера. Без этой
  // строки «SMS не приходят» на экране выглядит одинаково при любой причине.
  const [notice, setNotice] = useState("");
  // Яндекс ID — отдельный вход: его состояние и ошибки не должны смешиваться с SMS.
  const [yandex, setYandex] = useState<YandexAuthStatus | null>(null);
  const [yandexNotice, setYandexNotice] = useState("");
  const [vk, setVk] = useState<VkAuthStatus | null>(null);
  const [vkNotice, setVkNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  useEffect(() => {
    let alive = true;
    void getYandexAuthStatus().then(status => { if (alive) setYandex(status); }).catch(() => {});
    void getVkAuthStatus().then(status => { if (alive) setVk(status); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Read the OAuth result in an effect: a state initializer runs twice under StrictMode.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const yandexStatus = params.get("yandex_login");
    const vkStatus = params.get("vk_login");
    if (!yandexStatus && !vkStatus) return;
    params.delete("yandex_login");
    params.delete("vk_login");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : ""));
    if (yandexStatus) setYandexNotice(yandexNotices[yandexStatus] ?? yandexNotices.error);
    if (vkStatus) setVkNotice(vkNotices[vkStatus] ?? vkNotices.error);
  }, []);

  function signInWithYandex() {
    setError("");
    setYandexNotice("");
    setVkNotice("");
    const path = yandex?.loginPath ?? "/api/auth/yandex/start";
    window.location.href = path + "?origin=" + encodeURIComponent(window.location.origin);
  }

  function signInWithVk() {
    setError("");
    setYandexNotice("");
    setVkNotice("");
    const path = vk?.loginPath ?? "/api/auth/vk/start";
    window.location.href = path + "?origin=" + encodeURIComponent(window.location.origin);
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    setError("");
    setBusy(true);
    try {
      const data = await startPhoneLogin(phone, consent);
      // A configured demo number returns a session right away; nothing to type next.
      if (data.user) { onAuthenticated(); return; }
      setStage("code");
      setCode("");
      setNotice(data.notice ?? "");
      setSeconds(RESEND_SECONDS);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить код");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await verifyPhoneLogin(phone, code);
      onAuthenticated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось подтвердить код");
    } finally {
      setBusy(false);
    }
  }

  const yandexUnavailable = yandex?.configured === false;
  const vkUnavailable = vk?.configured === false;

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="auth-card-inner">
        <div className="brand auth-brand"><span className="brand-mark"><WebNestLogo size={24} tone="light"/></span><span>NestDev</span></div>
        <div className="auth-heading">
          <span className="eyebrow">АККАУНТ</span>
          <h1>{stage === "code" ? "Введите код из SMS" : "Вход в аккаунт"}</h1>
          {stage === "code"
            ? <p>Код отправлен на {phone}</p>
            : <p>Проекты сохраняются в вашем аккаунте.</p>}
        </div>

        {stage === "number" && <>
          <div className="auth-oauth-buttons">
            <button type="button" className="auth-yandex" onClick={signInWithYandex} disabled={yandexUnavailable}>
              <span className="auth-yandex-mark" aria-hidden="true">Я</span>
              Войти через Яндекс ID
            </button>
            <button type="button" className="auth-vk" onClick={signInWithVk} disabled={vkUnavailable}>
              <span className="auth-vk-mark" aria-hidden="true"><img src="/brand/logos/vk.svg" alt=""/></span>
              Войти через VK ID
            </button>
          </div>
          {yandexUnavailable && <div className="auth-oauth-hint">Яндекс ID сейчас недоступен — войдите по SMS.</div>}
          {vkUnavailable && <div className="auth-oauth-hint">VK ID сейчас недоступен — войдите по SMS.</div>}
          {yandexNotice && <div className="auth-error auth-yandex-error">{yandexNotice}</div>}
          {vkNotice && <div className="auth-error auth-oauth-error">{vkNotice}</div>}
          <div className="auth-divider">или по номеру телефона</div>
        </>}

        {stage === "number" && <form onSubmit={requestCode} className="auth-form">
          <label><span>Номер телефона</span><input type="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+7 999 123-45-67" autoComplete="tel" title="Номер для входа по SMS" required /></label>
          <label className="auth-consent">
            <input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); setError(""); }} />
            <span>Даю согласие на обработку номера телефона и технических данных для входа по SMS</span>
          </label>
          {/* Согласие даётся осознанно: текст согласия и политика открываются до отправки кода. */}
          <div className="auth-consent-links">
            <a href={legalPath("consent")} target="_blank" rel="noopener noreferrer">Согласие на обработку данных</a>
            <span>·</span>
            <a href={legalPath("privacy")} target="_blank" rel="noopener noreferrer">Политика обработки данных</a>
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button className="send-button auth-submit" disabled={busy || !phone.trim() || !consent}>{busy ? "Отправляем код…" : "Получить код"}</button>
        </form>}

        {stage === "code" && <form onSubmit={submitCode} className="auth-form">
          <label><span>Код из SMS</span><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} placeholder="123456" title="Код из SMS" required /></label>
          {notice && <div className="auth-note">{notice}</div>}
          {error && <div className="auth-error">{error}</div>}
          <button className="send-button auth-submit" disabled={busy || code.length < 4}>{busy ? "Проверяем…" : "Войти"}</button>
          <div className="auth-phone-actions">
            <button type="button" className="ghost-button" onClick={() => { setStage("number"); setError(""); setCode(""); }}>Изменить номер</button>
            <button type="button" className="ghost-button" disabled={seconds > 0 || busy} onClick={() => void requestCode()}>{seconds > 0 ? "Ещё раз через " + seconds + " с" : "Отправить ещё раз"}</button>
          </div>
        </form>}

        {/* Подвал входа: то, что человек вправе прочитать до регистрации. Ссылки открываются в
            новой вкладке, чтобы введённый номер и код не потерялись. */}
        <div className="auth-legal">
          <a href={legalPath("offer")} target="_blank" rel="noopener noreferrer">Оферта</a>
          <a href={legalPath("terms")} target="_blank" rel="noopener noreferrer">Соглашение</a>
          <a href={legalPath("privacy")} target="_blank" rel="noopener noreferrer">Персональные данные</a>
          <button type="button" className="ghost-button" onClick={openCookieSettings}>Cookie-настройки</button>
        </div>
      </div>
    </section>
    <aside className="auth-visual" aria-hidden="true">
      <img src={AUTH_ART} alt="" loading="eager" decoding="async"/>
    </aside>
  </main>;
}
