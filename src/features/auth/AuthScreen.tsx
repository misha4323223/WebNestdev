import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../lib/api";
import { confirmPasswordReset, getVkAuthStatus, getYandexAuthStatus, login as loginByEmail, register as registerByEmail, requestPasswordReset, resendVerification, verifyEmail as confirmEmail, type VkAuthStatus, type YandexAuthStatus } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";
import { openCookieSettings } from "../legal/CookieConsent";
import { legalPath } from "../../lib/legal";

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
  not_configured: "Вход через VK ID временно недоступен. Используйте вход по почте.",
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
  not_configured: "Вход через Яндекс ID временно недоступен. Используйте вход по почте.",
  state_expired: "Ссылка входа через Яндекс ID устарела. Нажмите кнопку ещё раз.",
  token_error: "Яндекс не выдал токен входа. Попробуйте ещё раз.",
  profile_error: "Яндекс ID не отдал профиль. В приложении на oauth.yandex.ru должно быть включено право «Доступ к логину, имени и фамилии, полу» (login:info).",
  error: "Не удалось завершить вход через Яндекс ID.",
  blocked: "Аккаунт заблокирован администратором. Напишите в поддержку.",
};

export function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [emailMode, setEmailMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // Адрес, на который отправлено письмо. Пока он задан, форма заменена экраном ожидания.
  const [pendingEmail, setPendingEmail] = useState<string|null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState("");
  const [verificationNotice, setVerificationNotice] = useState("");
  // Токен из письма. Он открывает форму, но аккаунт подтверждается только вместе с паролем.
  const [verificationToken, setVerificationToken] = useState<string|null>(null);
  const [verificationPassword, setVerificationPassword] = useState("");
  // Восстановление пароля: запрос письма и форма нового пароля по ссылке из него.
  const [forgotMode, setForgotMode] = useState(false);
  const [resetSentTo, setResetSentTo] = useState<string|null>(null);
  const [resetToken, setResetToken] = useState<string|null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetRepeat, setResetRepeat] = useState("");
  // Яндекс ID и VK ID — отдельные способы входа: их состояние и ошибки не должны
  // смешиваться с формой почты.
  const [yandex, setYandex] = useState<YandexAuthStatus | null>(null);
  const [yandexNotice, setYandexNotice] = useState("");
  const [vk, setVk] = useState<VkAuthStatus | null>(null);
  const [vkNotice, setVkNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void getYandexAuthStatus().then(status => { if (alive) setYandex(status); }).catch(() => {});
    void getVkAuthStatus().then(status => { if (alive) setVk(status); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Read the OAuth/email result in an effect: a state initializer runs twice under StrictMode.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const yandexStatus = params.get("yandex_login");
    const vkStatus = params.get("vk_login");
    const verifyToken = params.get("verify_email");
    const resetValue = params.get("reset_password");
    if (!yandexStatus && !vkStatus && !verifyToken && !resetValue) return;
    for (const name of ["yandex_login", "vk_login", "verify_email", "reset_password"]) params.delete(name);
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : ""));
    if (yandexStatus) setYandexNotice(yandexNotices[yandexStatus] ?? yandexNotices.error);
    if (vkStatus) setVkNotice(vkNotices[vkStatus] ?? vkNotices.error);
    if (verifyToken) { setVerificationToken(verifyToken); setPendingEmail(null); setResetToken(null); }
    if (resetValue) { setResetToken(resetValue); setPendingEmail(null); setVerificationToken(null); setForgotMode(false); setResetSentTo(null); }
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

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    setError("");
    setResendNotice("");
    setVerificationNotice("");
    setBusy(true);
    try {
      if (emailMode === "register") {
        const result = await registerByEmail(email.trim(), password);
        // Сессии ещё нет: сервер выдаст её только после перехода по ссылке из письма.
        setPendingEmail(result.email);
        setPassword("");
        return;
      }
      await loginByEmail(email.trim(), password);
      onAuthenticated();
    } catch (e) {
      if (e instanceof ApiError && e.code === "EMAIL_NOT_VERIFIED") {
        setPendingEmail(email.trim());
        setVerificationNotice("Почта ещё не подтверждена. Отправьте письмо ещё раз.");
        setError("");
        return;
      }
      if (e instanceof ApiError && e.code === "EMAIL_SEND_FAILED") {
        // Аккаунт уже создан; экран ожидания позволяет отправить письмо повторно.
        setPendingEmail(email.trim());
        setError(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : emailMode === "register" ? "Не удалось создать аккаунт" : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  async function submitVerification(event: FormEvent) {
    event.preventDefault();
    if (!verificationToken) return;
    setError("");
    setVerificationNotice("");
    setBusy(true);
    try {
      await confirmEmail(verificationToken, verificationPassword);
      onAuthenticated();
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERIFICATION_EXPIRED") {
        setVerificationNotice("Срок ссылки подтверждения истёк. Вернитесь на экран регистрации и запросите новое письмо.");
      } else {
        setError(e instanceof Error ? e.message : "Не удалось подтвердить почту");
      }
    } finally {
      setBusy(false);
    }
  }

  function cancelVerification() {
    setVerificationToken(null);
    setVerificationPassword("");
    setError("");
    setVerificationNotice("");
    setEmailMode("login");
  }

  /** «Забыли пароль?»: письмо уходит только на настоящий адрес, но ответ экрана всегда один. */
  async function submitForgot(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
      setResetSentTo(email.trim());
      setForgotMode(false);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить письмо");
    } finally {
      setBusy(false);
    }
  }

  /** Новый пароль по ссылке. Сервер сам отзывает старые сессии и открывает эту. */
  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (!resetToken) return;
    setError("");
    if (resetPassword.length < 8) { setError("Пароль должен быть не короче 8 символов"); return; }
    if (resetPassword !== resetRepeat) { setError("Пароли не совпадают"); return; }
    setBusy(true);
    try {
      await confirmPasswordReset(resetToken, resetPassword);
      onAuthenticated();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "PASSWORD_RESET_EXPIRED"
        ? "Срок ссылки истёк. Запросите новое письмо на экране входа."
        : e instanceof Error ? e.message : "Не удалось сменить пароль");
    } finally {
      setBusy(false);
    }
  }

  function startForgot() {
    setForgotMode(true);
    setResetSentTo(null);
    setError("");
    setResendNotice("");
    setVerificationNotice("");
    setYandexNotice("");
    setVkNotice("");
  }

  function cancelReset() {
    setResetToken(null);
    setResetPassword("");
    setResetRepeat("");
    setForgotMode(false);
    setResetSentTo(null);
    setError("");
    setResendNotice("");
    setVerificationNotice("");
    setEmailMode("login");
  }

  async function resendEmail() {
    if (!pendingEmail) return;
    setResendBusy(true);
    setError("");
    setResendNotice("");
    try {
      const result = await resendVerification(pendingEmail);
      setResendNotice(result.retryAfter
        ? `Письмо уже отправлено. Новое можно запросить через ${result.retryAfter} с.`
        : "Письмо отправлено повторно. Проверьте «Входящие» и «Спам».");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить письмо");
    } finally {
      setResendBusy(false);
    }
  }

  function changeEmail() {
    setPendingEmail(null);
    setVerificationToken(null);
    setEmailMode("register");
    setPassword("");
    setError("");
    setResendNotice("");
    setVerificationNotice("");
  }

  function switchEmailMode() {
    setEmailMode(current => current === "login" ? "register" : "login");
    setVerificationToken(null);
    setError("");
    setResendNotice("");
    setVerificationNotice("");
  }

  const yandexUnavailable = yandex?.configured === false;
  const vkUnavailable = vk?.configured === false;

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="auth-card-inner">
        <div className="brand auth-brand"><span className="brand-mark"><WebNestLogo size={24} tone="light"/></span><span>NestDev</span></div>
        <div className="auth-heading">
          <span className="eyebrow">{resetToken ? "ВОССТАНОВЛЕНИЕ" : verificationToken ? "ПОДТВЕРЖДЕНИЕ" : resetSentTo || pendingEmail || forgotMode ? "ПОЧТА" : "АККАУНТ"}</span>
          <h1>{resetToken ? "Новый пароль" : verificationToken ? "Подтвердите почту" : resetSentTo || pendingEmail ? "Проверьте почту" : forgotMode ? "Восстановление пароля" : emailMode === "register" ? "Создайте аккаунт" : "Вход в аккаунт"}</h1>
          {resetToken
            ? <p>Придумайте новый пароль. После сохранения все старые входы завершатся, а этот откроется сразу.</p>
            : verificationToken
              ? <p>Введите пароль, который вы указали при регистрации. Так аккаунт подтвердит именно его владелец.</p>
              : resetSentTo
                ? <p>Если аккаунт с адресом <strong>{resetSentTo}</strong> существует, письмо со ссылкой уже отправлено. Ссылка действует 1 час.</p>
                : pendingEmail
                  ? <p>Мы отправили ссылку на <strong>{pendingEmail}</strong>. Она действует 24 часа.</p>
                  : forgotMode
                    ? <p>Укажите почту, на которую зарегистрирован аккаунт. Пришлём ссылку для нового пароля.</p>
                    : emailMode === "login" && <p>Введите почту и пароль от аккаунта NestDev.</p>}
        </div>

        {resetToken ? (
          <form onSubmit={submitReset} className="auth-form">
            {error && <div className="auth-error">{error}</div>}
            <label><span>Новый пароль</span><input type="password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} placeholder="Не меньше 8 символов" autoComplete="new-password" minLength={8} title="Новый пароль" autoFocus required /></label>
            <label><span>Повторите пароль</span><input type="password" value={resetRepeat} onChange={event => setResetRepeat(event.target.value)} placeholder="Ещё раз" autoComplete="new-password" minLength={8} title="Повторите новый пароль" required /></label>
            <div className="auth-hint">После смены пароля остальные устройства выйдут из аккаунта, а это — сразу войдёт.</div>
            <button className="send-button auth-submit" disabled={busy || resetPassword.length < 8 || resetRepeat.length < 8}>
              {busy ? "Сохраняем…" : "Сохранить пароль"}
            </button>
            <div className="auth-switch">
              <span>Ссылка не подходит?</span>
              <button type="button" className="ghost-button" onClick={cancelReset}>Вернуться ко входу</button>
            </div>
          </form>
        ) : verificationToken ? (
          <form onSubmit={submitVerification} className="auth-form">
            {verificationNotice && <div className="auth-error">{verificationNotice}</div>}
            {error && <div className="auth-error">{error}</div>}
            <label><span>Пароль</span><input type="password" value={verificationPassword} onChange={event => setVerificationPassword(event.target.value)} placeholder="Пароль от аккаунта" autoComplete="current-password" title="Пароль от аккаунта" autoFocus required /></label>
            <div className="auth-hint">Ссылка действует 24 часа. После подтверждения вы сразу войдёте в аккаунт.</div>
            <button className="send-button auth-submit" disabled={busy || !verificationPassword}>
              {busy ? "Подтверждаем…" : "Подтвердить почту"}
            </button>
            <div className="auth-switch">
              <span>Ссылка не подходит?</span>
              <button type="button" className="ghost-button" onClick={cancelVerification}>Вернуться ко входу</button>
            </div>
          </form>
        ) : resetSentTo ? (
          <div className="auth-verification">
            <div className="auth-success">Проверьте «Входящие» и «Спам». Ссылка работает один раз и действует час.</div>
            <div className="auth-hint">Если письма нет, проверьте адрес или запросите его ещё раз через минуту. Если аккаунт создан по телефону или через Яндекс ID / VK ID, пароля у него нет — войдите тем же способом.</div>
            <button type="button" className="send-button auth-submit" onClick={cancelReset}>Вернуться ко входу</button>
            <div className="auth-switch">
              <span>Не тот адрес?</span>
              <button type="button" className="ghost-button" onClick={() => { setResetSentTo(null); startForgot(); }}>Изменить почту</button>
            </div>
          </div>
        ) : pendingEmail ? (
          <div className="auth-verification">
            {verificationNotice && <div className="auth-error">{verificationNotice}</div>}
            {resendNotice && <div className="auth-success">{resendNotice}</div>}
            {error && <div className="auth-error">{error}</div>}
            <div className="auth-hint">Откройте ссылку из письма и подтвердите вход паролем. Если письма нет, проверьте «Спам» или отправьте его ещё раз.</div>
            <button type="button" className="send-button auth-submit" onClick={() => void resendEmail()} disabled={resendBusy}>
              {resendBusy ? "Отправляем…" : "Отправить письмо ещё раз"}
            </button>
            <div className="auth-switch">
              <span>Не тот адрес?</span>
              <button type="button" className="ghost-button" onClick={changeEmail}>Изменить почту</button>
            </div>
          </div>
        ) : forgotMode ? (
          <form onSubmit={submitForgot} className="auth-form">
            {error && <div className="auth-error">{error}</div>}
            <label><span>Почта</span><input type="email" inputMode="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" title="Почта для входа" autoFocus required /></label>
            <div className="auth-hint">Ответ одинаковый для любого адреса: форма не показывает, зарегистрирован ли он.</div>
            <button className="send-button auth-submit" disabled={busy || !email.trim()}>
              {busy ? "Отправляем…" : "Отправить ссылку"}
            </button>
            <div className="auth-switch">
              <span>Вспомнили пароль?</span>
              <button type="button" className="ghost-button" onClick={cancelReset}>Вернуться ко входу</button>
            </div>
          </form>
        ) : (
          <>
            {verificationNotice && <div className="auth-error auth-verification-notice">{verificationNotice}</div>}
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
            {yandexUnavailable && <div className="auth-oauth-hint">Яндекс ID сейчас недоступен — войдите по почте.</div>}
            {vkUnavailable && <div className="auth-oauth-hint">VK ID сейчас недоступен — войдите по почте.</div>}
            {yandexNotice && <div className="auth-error auth-yandex-error">{yandexNotice}</div>}
            {vkNotice && <div className="auth-error auth-oauth-error">{vkNotice}</div>}
            <div className="auth-divider">или по почте</div>

            <form onSubmit={submitEmail} className="auth-form">
              <label><span>Почта</span><input type="email" inputMode="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" title="Почта для входа" required /></label>
              <label><span>Пароль</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Не меньше 8 символов" autoComplete={emailMode === "register" ? "new-password" : "current-password"} minLength={8} title="Пароль от аккаунта" required /></label>
              {emailMode === "register" && <div className="auth-hint">Пароль должен быть не короче 8 символов. Почта станет логином после подтверждения.</div>}
              {error && <div className="auth-error">{error}</div>}
              <button className="send-button auth-submit" disabled={busy || !email.trim() || password.length < 8}>
                {busy ? (emailMode === "register" ? "Создаём аккаунт…" : "Входим…") : emailMode === "register" ? "Зарегистрироваться" : "Войти"}
              </button>
              <div className="auth-switch">
                <span>{emailMode === "register" ? "Уже есть аккаунт?" : "Впервые здесь?"}</span>
                <button type="button" className="ghost-button" onClick={switchEmailMode}>{emailMode === "register" ? "Войти" : "Создать аккаунт"}</button>
              </div>
              {emailMode === "login" && <div className="auth-switch">
                <span>Забыли пароль?</span>
                <button type="button" className="ghost-button" onClick={startForgot}>Восстановить</button>
              </div>}
            </form>
          </>
        )}

        {/* Подвал входа: то, что человек вправе прочитать до регистрации. Ссылки открываются в
            новой вкладке, чтобы введённые данные не потерялись. */}
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
