import { useEffect, useState, type FormEvent } from "react";
import { startPhoneLogin, verifyPhoneLogin } from "../../lib/auth-api";
import { getHealth } from "../../lib/health-api";
import { WebNestLogo } from "../../components/WebNestLogo";

const RESEND_SECONDS = 45;

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
  // Номер сборки, которая работает на сервере: по нему видно, что страница не взята из кеша.
  const [build, setBuild] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  useEffect(() => {
    let alive = true;
    void getHealth().then(health => { if (alive) setBuild(health.build); }).catch(() => {});
    return () => { alive = false; };
  }, []);

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

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="brand auth-brand"><span className="brand-mark"><WebNestLogo size={24} tone="light"/></span><span>WebNestdev</span><span className="version">WEB</span></div>
      <div className="auth-heading">
        <span className="eyebrow">АККАУНТ</span>
        <h1>{stage === "code" ? "Введите код из SMS" : "Вход по номеру телефона"}</h1>
        {stage === "code" && <p>Код отправлен на {phone}</p>}
      </div>

      {stage === "number" && <form onSubmit={requestCode} className="auth-form">
        <label><span>Номер телефона</span><input type="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+7 999 123-45-67" autoComplete="tel" required /></label>
        <label className="auth-consent">
          <input type="checkbox" checked={consent} onChange={event => { setConsent(event.target.checked); setError(""); }} />
          <span>Согласен на обработку номера телефона для входа по SMS</span>
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="send-button auth-submit" disabled={busy || !phone.trim() || !consent}>{busy ? "Отправляем код…" : "Получить код"}</button>
      </form>}

      {stage === "code" && <form onSubmit={submitCode} className="auth-form">
        <label><span>Код из SMS</span><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} placeholder="123456" required /></label>
        {notice && <div className="auth-note">{notice}</div>}
        {error && <div className="auth-error">{error}</div>}
        <button className="send-button auth-submit" disabled={busy || code.length < 4}>{busy ? "Проверяем…" : "Войти"}</button>
        <div className="auth-phone-actions">
          <button type="button" className="ghost-button" onClick={() => { setStage("number"); setError(""); setCode(""); }}>Изменить номер</button>
          <button type="button" className="ghost-button" disabled={seconds > 0 || busy} onClick={() => void requestCode()}>{seconds > 0 ? "Ещё раз через " + seconds + " с" : "Отправить ещё раз"}</button>
        </div>
      </form>}

      {build && build !== "dev" && <div className="auth-build">версия {build.slice(0, 7)}</div>}
    </section>
  </main>;
}
