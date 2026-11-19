import { useEffect, useState } from "react";
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, FileCheck2, Globe2, Info,
  Loader2, RefreshCw, Search, ShieldAlert, ShieldCheck,
} from "lucide-react";
import {
  runHostingSeoAudit, updateHostingSeo,
  type HostingRoutingMode, type HostingTrailingSlash, type HostingSeoAudit, type HostingSeoView, type SeoAuditIssue,
} from "../../lib/hosting-api";

const MODES: Array<{ id: HostingRoutingMode; label: string; hint: string }> = [
  { id: "auto", label: "Авто", hint: "При публикации: несколько HTML или 404.html — static, иначе SPA." },
  { id: "static", label: "Static", hint: "Каждый путь — отдельный файл, неизвестный путь отвечает 404." },
  { id: "spa", label: "SPA", hint: "Один index.html для клиентских маршрутов; отсутствующие .js остаются 404." },
  { id: "hybrid", label: "Hybrid", hint: "SPA только для /app/*, остальные страницы — как static." },
];

const SLASHES: Array<{ id: HostingTrailingSlash; label: string; hint: string }> = [
  { id: "always", label: "/about/", hint: "Каталог всегда со слешем; /about отвечает 301." },
  { id: "never", label: "/about", hint: "Каталог без слеша; /about/ отвечает 301." },
  { id: "ignore", label: "Не менять", hint: "Оставить адреса как в сборке; canonical всё равно должен быть один." },
];

function modeLabel(mode: string) {
  return MODES.find(item => item.id === mode)?.label ?? mode;
}

function sourceLabel(source: HostingSeoView["sitemapSource"]) {
  if (source === "user") return "свой";
  if (source === "generated") return "платформенный";
  return "нет файла";
}

function levelMeta(level: SeoAuditIssue["level"]) {
  if (level === "critical") return { label: "Критично", icon: <ShieldAlert size={13}/>, className: "critical" };
  if (level === "warning") return { label: "Предупреждение", icon: <AlertTriangle size={13}/>, className: "warning" };
  return { label: "Совет", icon: <Info size={13}/>, className: "info" };
}

function AuditList({ audit }: { audit: HostingSeoAudit }) {
  const groups: Array<SeoAuditIssue["level"]> = ["critical", "warning", "info"];
  if (!audit.issues.length) {
    return <div className="seo-ok"><CheckCircle2 size={14}/> Технических замечаний нет.</div>;
  }
  return <div className="seo-issues">
    {groups.map(level => {
      const items = audit.issues.filter(item => item.level === level);
      if (!items.length) return null;
      const meta = levelMeta(level);
      return <div className={"seo-issue-group " + meta.className} key={level}>
        <div className="seo-issue-head">{meta.icon}<strong>{meta.label}</strong><span>{items.length}</span></div>
        {items.map(item => <div className="seo-issue" key={item.id}>
          <div className="seo-issue-title">{item.title}</div>
          <div className="seo-issue-detail">{item.detail}</div>
          {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.url.replace(/^https?:\/\//, "")}<ArrowUpRight size={11}/></a> : null}
        </div>)}
      </div>;
    })}
  </div>;
}

export function SeoCard({
  projectId,
  seo,
  onReload,
  disabled,
  hasRelease,
}: {
  projectId: string;
  seo: HostingSeoView;
  onReload: () => Promise<void>;
  disabled?: boolean;
  /** Аудит требует активный релиз; режим можно выбрать и до первой публикации. */
  hasRelease: boolean;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [audit, setAudit] = useState<HostingSeoAudit | null>(seo.audit);
  const [googleToken, setGoogleToken] = useState("");
  // Родитель перечитывает состояние после смены режима; не держим старый аудит от
  // предыдущего проекта/релиза, если компонент остался смонтированным.
  useEffect(() => { setAudit(seo.audit); }, [seo.audit]);

  const setMode = async (mode: HostingRoutingMode) => {
    if (mode === seo.routingMode || busy) return;
    setBusy("mode");
    setError("");
    try {
      await updateHostingSeo(projectId, mode);
      await onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };

  const setSlash = async (slash: HostingTrailingSlash) => {
    if (slash === seo.trailingSlash || busy) return;
    setBusy("slash");
    setError("");
    try {
      await updateHostingSeo(projectId, { trailingSlash: slash });
      await onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };

  const saveGoogle = async (remove = false) => {
    if (busy || (!remove && !googleToken.trim())) return;
    setBusy("google");
    setError("");
    try {
      await updateHostingSeo(projectId, { googleVerification: remove ? null : googleToken.trim() });
      if (remove) setGoogleToken("");
      await onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };

  const auditNow = async () => {
    setBusy("audit");
    setError("");
    try {
      const result = await runHostingSeoAudit(projectId);
      setAudit(result.audit);
      await onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };

  const effective = seo.effectiveRoutingMode;
  return <div className="hosting-seo-card">
    <div className="hosting-section-head">
      <div className="hosting-section-title"><Search size={14}/><strong>SEO и индексация</strong></div>
      <button className="ghost-button" onClick={() => void auditNow()} disabled={Boolean(busy) || disabled || !hasRelease}>
        {busy === "audit" ? <Loader2 size={13} className="spin"/> : <RefreshCw size={13}/>} Проверить
      </button>
    </div>

    {error ? <div className="hosting-alert error"><AlertTriangle size={13}/><span>{error}</span></div> : null}

    <div className="seo-grid">
      <div className="seo-block">
        <span className="seo-label">Основной адрес</span>
        <a className="hosting-url" href={seo.primaryUrl} target="_blank" rel="noreferrer">
          {seo.primaryUrl.replace(/^https?:\/\//, "")}<ArrowUpRight size={12}/>
        </a>
        {seo.canonicalHostname
          ? <small>Пользовательский домен активен. Платформенный адрес <span>{seo.platformUrl.replace(/^https?:\/\//, "")}</span> отвечает 301.</small>
          : <small>Canonical и sitemap используют платформенный адрес.</small>}
      </div>

      <div className="seo-block">
        <span className="seo-label">Индексируемость</span>
        <div className="seo-files">
          <a href={seo.sitemapUrl} target="_blank" rel="noreferrer"><FileCheck2 size={13}/> sitemap.xml <span>{sourceLabel(seo.sitemapSource)}{seo.sitemapChunks ? " · index, " + seo.sitemapChunks + " куска" : ""}</span></a>
          <a href={seo.robotsUrl} target="_blank" rel="noreferrer"><ShieldCheck size={13}/> robots.txt <span>{sourceLabel(seo.robotsSource)}</span></a>
          <span className={seo.has404 ? "seo-good" : "seo-muted"}>{seo.has404 ? <CheckCircle2 size={13}/> : <Info size={13}/>} 404.html {seo.has404 ? "есть" : "нет"}</span>
          <span className={seo.cdn?.enabled ? "seo-good" : "seo-muted"}>{seo.cdn?.enabled ? <CheckCircle2 size={13}/> : <Info size={13}/>} CDN purge {seo.cdn?.enabled ? "включён" : "не настроен"}</span>
        </div>
        <small>CDN сбрасывается после публикации для не-хешированных файлов. Ошибка сброса не отменяет уже переключённый релиз.</small>
      </div>
    </div>

    <div className="seo-mode">
      <div className="seo-mode-head">
        <span className="seo-label">Как отдавать страницы</span>
        <span className="seo-effective">Сейчас: <strong>{modeLabel(effective)}</strong>{seo.routingMode === "auto" ? " (определено автоматически)" : ""}</span>
      </div>
      <div className="seo-mode-options" role="radiogroup" aria-label="Режим отдачи сайта">
        {MODES.map(mode => <button
          key={mode.id}
          type="button"
          role="radio"
          aria-checked={seo.routingMode === mode.id}
          className={"seo-mode-option " + (seo.routingMode === mode.id ? "active" : "")}
          onClick={() => void setMode(mode.id)}
          disabled={Boolean(busy) || disabled}
          title={mode.hint}
        >
          <strong>{mode.label}</strong>
          <span>{mode.hint}</span>
          {seo.routingMode === mode.id && busy === "mode" ? <Loader2 size={12} className="spin"/> : null}
        </button>)}
      </div>
    </div>

    <div className="seo-mode">
      <div className="seo-mode-head">
        <span className="seo-label">Хвостовой слеш</span>
        <span className="seo-effective">Сейчас: <strong>{SLASHES.find(item => item.id === seo.trailingSlash)?.label ?? seo.trailingSlash}</strong></span>
      </div>
      <div className="seo-mode-options" role="radiogroup" aria-label="Хвостовой слеш в адресах">
        {SLASHES.map(item => <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={seo.trailingSlash === item.id}
          className={"seo-mode-option " + (seo.trailingSlash === item.id ? "active" : "")}
          onClick={() => void setSlash(item.id)}
          disabled={Boolean(busy) || disabled}
          title={item.hint}
        >
          <strong>{item.label}</strong>
          <span>{item.hint}</span>
          {seo.trailingSlash === item.id && busy === "slash" ? <Loader2 size={12} className="spin"/> : null}
        </button>)}
      </div>
    </div>

    <div className="seo-block seo-redirects">
      <span className="seo-label">Редиректы</span>
      {seo.redirects.present ? <>
        <small>Файл <code>_redirects</code>: применено правил — <strong>{seo.redirects.count}</strong>.</small>
        {seo.redirects.errors.length ? <div className="seo-warning">
          <AlertTriangle size={13}/>
          <span>{seo.redirects.errors.slice(0, 4).join(" · ")}</span>
        </div> : null}
      </> : <small>Файла <code>_redirects</code> в релизе нет. Добавьте его в корень проекта перед публикацией.</small>}
      <small className="seo-muted">Поддерживаются внутренние пути, 301/302 и один <code>*</code> в конце источника с <code>:splat</code> в цели. Query сохраняется.</small>
    </div>

    <div className="seo-block seo-search-console">
      <div className="hosting-section-title"><Search size={13}/><strong>Google Search Console</strong></div>
      {seo.googleVerification ? <>
        <small>{seo.googleVerificationReady ? "Файл подтверждения готов: " : "Токен сохранён; файл появится после публикации: "}<a href={seo.googleVerificationUrl ?? seo.primaryUrl} target="_blank" rel="noreferrer">{seo.googleVerificationUrl ?? "открыть файл"}<ArrowUpRight size={11}/></a>. Добавьте этот адрес как HTML-файл в Search Console.</small>
        <button className="ghost-button" type="button" onClick={() => void saveGoogle(true)} disabled={Boolean(busy)}>Удалить проверку</button>
      </> : <>
        <small>Вставьте HTML-токен из Search Console — платформа отдаст файл <code>google&lt;токен&gt;.html</code> без новой публикации.</small>
        <div className="seo-token-row">
          <input
            value={googleToken}
            onChange={event => setGoogleToken(event.target.value)}
            placeholder="google-site-verification token"
            aria-label="Токен Google Search Console"
            disabled={Boolean(busy) || disabled}
          />
          <button className="ghost-button" type="button" onClick={() => void saveGoogle()} disabled={Boolean(busy) || disabled || !googleToken.trim()}>
            {busy === "google" ? <Loader2 size={12} className="spin"/> : null} Сохранить
          </button>
        </div>
      </>}
    </div>

    <div className="seo-audit">
      <div className="seo-audit-head">
        <span className="seo-label">Технический аудит</span>
        {audit?.checkedAt ? <span className="seo-muted">{new Date(audit.checkedAt).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {audit.pages} стр.</span> : null}
      </div>
      {audit ? <>
        {seo.auditStale ? <div className="seo-stale"><Info size={13}/> Аудит был до смены адреса или режима. Запустите проверку снова.</div> : null}
        <AuditList audit={audit}/>
      </> : <div className="seo-empty">
        <Globe2 size={16}/>
        <span>Проверим title, description, H1, canonical, sitemap/robots, 404 и индексацию. Это технический чек-лист, а не оценка позиций.</span>
      </div>}
    </div>
  </div>;
}
