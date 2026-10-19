import { useEffect, useState } from "react";
import { BarChart3, Check, Cookie, ShieldCheck, SlidersHorizontal, X } from "lucide-react";

/**
 * Согласие на cookie по умолчанию спрашивается один раз и запоминается на устройстве.
 * Обязательные cookie (сессия входа и защита запросов) работают всегда; аналитика и
 * функциональные настройки включаются только после явного выбора.
 */
const STORAGE_KEY = "webnestdev.cookieConsent";
const CONSENT_VERSION = 1;
const SETTINGS_EVENT = "webnestdev:cookie-settings";

type CookieChoice = {
  version: number;
  necessary: true;
  analytics: boolean;
  functional: boolean;
  decidedAt: string;
};
type CookieDraft = { analytics: boolean; functional: boolean };

function readChoice(): CookieChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CookieChoice>;
    if (value.version !== CONSENT_VERSION || value.necessary !== true) return null;
    return {
      version: CONSENT_VERSION,
      necessary: true,
      analytics: value.analytics === true,
      functional: value.functional === true,
      decidedAt: typeof value.decidedAt === "string" ? value.decidedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function saveChoice(draft: CookieDraft): CookieChoice {
  const next: CookieChoice = {
    version: CONSENT_VERSION,
    necessary: true,
    analytics: draft.analytics,
    functional: draft.functional,
    decidedAt: new Date().toISOString(),
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  try { window.dispatchEvent(new CustomEvent("webnestdev:cookie-consent", { detail: next })); } catch {}
  return next;
}

/** Открыть окно cookie-настроек из любого экрана: согласие можно изменить в любой момент. */
export function openCookieSettings() {
  try { window.dispatchEvent(new Event(SETTINGS_EVENT)); } catch {}
}

export function CookieConsent() {
  const [choice, setChoice] = useState<CookieChoice | null>(readChoice);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CookieDraft>(() => ({
    analytics: choice?.analytics ?? false,
    functional: choice?.functional ?? false,
  }));

  useEffect(() => {
    const handler = () => {
      const current = readChoice();
      setDraft({ analytics: current?.analytics ?? false, functional: current?.functional ?? false });
      setOpen(true);
    };
    window.addEventListener(SETTINGS_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function decide(next: CookieDraft) {
    setChoice(saveChoice(next));
    setOpen(false);
  }

  const bannerVisible = choice === null && !open;

  return <>
    {bannerVisible && <aside className="cookie-banner" aria-label="Согласие на использование cookie">
      <div className="cookie-banner-glow" aria-hidden="true"/>
      <div className="cookie-head">
        <span className="cookie-icon"><Cookie size={18}/></span>
        <div className="cookie-title">
          <strong>Cookie и приватность</strong>
          <span>Необходимые cookie нужны для входа и защиты аккаунта. Аналитика и удобства — только с вашего согласия.</span>
        </div>
      </div>
      <div className="cookie-actions">
        <button type="button" className="cookie-action cookie-primary" onClick={() => decide({ analytics: true, functional: true })}>
          <Check size={13}/> Принять все
        </button>
        <button type="button" className="cookie-action cookie-secondary" onClick={() => decide({ analytics: false, functional: false })}>
          Только необходимые
        </button>
        <button type="button" className="cookie-action cookie-customize" onClick={() => setOpen(true)}>
          <SlidersHorizontal size={12}/> Настроить
        </button>
      </div>
    </aside>}

    {open && <div className="modal-backdrop cookie-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
      <section className="modal cookie-modal" role="dialog" aria-modal="true" aria-label="Настройки cookie" onMouseDown={event => event.stopPropagation()}>
        <header className="modal-head">
          <div className="cookie-modal-title">
            <span className="cookie-icon"><Cookie size={18}/></span>
            <div>
              <span className="eyebrow">ПРИВАТНОСТЬ</span>
              <h2>Настройки cookie</h2>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Закрыть"><X size={16}/></button>
        </header>

        <div className="modal-body cookie-modal-body">
          <p className="modal-lead">Выберите, что можно хранить на этом устройстве. Обязательные cookie обеспечивают вход и безопасность; без них сервис не работает.</p>

          <div className="cookie-categories">
            <div className="cookie-category">
              <span className="cookie-category-icon"><ShieldCheck size={15}/></span>
              <span className="cookie-category-text">
                <strong>Необходимые <span className="cookie-required">всегда включены</span></strong>
                <small>Сессия входа, защита запросов и сохранение вашего выбора. Эти cookie нельзя отключить.</small>
              </span>
              <span className="switch"><input type="checkbox" checked disabled onChange={() => {}}/><span className="switch-track"><span className="switch-thumb"/></span></span>
            </div>

            <label className="cookie-category">
              <span className="cookie-category-icon"><BarChart3 size={15}/></span>
              <span className="cookie-category-text">
                <strong>Аналитика</strong>
                <small>Обезличенная статистика использования, чтобы понимать, какие экраны стоит улучшить.</small>
              </span>
              <span className="switch"><input type="checkbox" checked={draft.analytics} onChange={event => setDraft(current => ({ ...current, analytics: event.target.checked }))}/><span className="switch-track"><span className="switch-thumb"/></span></span>
            </label>

            <label className="cookie-category">
              <span className="cookie-category-icon"><SlidersHorizontal size={15}/></span>
              <span className="cookie-category-text">
                <strong>Функциональные</strong>
                <small>Запоминают настройки интерфейса, чтобы не выбирать их заново при каждом визите.</small>
              </span>
              <span className="switch"><input type="checkbox" checked={draft.functional} onChange={event => setDraft(current => ({ ...current, functional: event.target.checked }))}/><span className="switch-track"><span className="switch-thumb"/></span></span>
            </label>
          </div>

          <p className="cookie-modal-note">Необязательные cookie подключаются только после вашего выбора. Согласие можно изменить позже: «Настройки» → «Аккаунт и тариф» → «Предпочтения» → «Cookie-настройки».</p>
        </div>

        <footer className="modal-foot cookie-modal-foot">
          <button type="button" className="ghost-button" onClick={() => decide({ analytics: false, functional: false })}>Только необходимые</button>
          <div className="cookie-modal-actions">
            <button type="button" className="ghost-button" onClick={() => decide({ analytics: true, functional: true })}>Принять все</button>
            <button type="button" className="cookie-action cookie-primary" onClick={() => decide(draft)}>Сохранить выбор</button>
          </div>
        </footer>
      </section>
    </div>}
  </>;
}
