import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Check, Clock3, Copy, ExternalLink, FileCode2, Globe2, Loader2,
  Pencil, RefreshCw, Rocket, ShieldCheck, Trash2, EyeOff, X,
} from "lucide-react";
import {
  createHosting, deleteHosting, getHosting, getHostingReleaseLog, publishHosting,
  rollbackHosting, unpublishHosting, updateHostingSlug, type HostingRelease, type HostingState,
} from "../../lib/hosting-api";

/**
 * Вкладка «Хостинг». Сайт — не процесс: после публикации файлы лежат на диске и отдаются
 * Caddy, поэтому здесь нет кнопки «запустить сервер». Пока идёт сборка, панель опрашивает
 * статус; после неё показывает URL и историю релизов.
 */
export function HostingPanel({ projectId }: { projectId: string }) {
  const [state, setState] = useState<HostingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [log, setLog] = useState<{ releaseId: string; text: string } | null>(null);
  const [newSlug, setNewSlug] = useState("");
  const [editingSlug, setEditingSlug] = useState(false);
  const [slugValue, setSlugValue] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await getHosting(projectId);
      setState(next);
      setError("");
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setEditingSlug(false); setSlugValue(""); setNewSlug(""); }, [projectId]);

  // Сборка идёт на сервере; страница не должна держать WebSocket ради одного статуса.
  // Опрос прекращается, как только `building` исчезает из состояния.
  useEffect(() => {
    if (!state) return;
    const building = Boolean(state.site?.publishingReleaseId) || state.releases.some(release => release.status === "building");
    if (!building) return;
    const timer = window.setTimeout(() => { void load(true); }, 2500);
    return () => window.clearTimeout(timer);
  }, [state, load]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError("");
    try {
      await action();
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  };

  const createAndPublish = () => run("create", async () => {
    await createHosting(projectId, newSlug.trim() || undefined);
    try {
      await publishHosting(projectId);
    } catch (error) {
      // Сайт уже создан; показываем карточку и ошибку публикации, а не пустой hero.
      await load(true);
      throw error;
    }
  });

  const startEditSlug = () => {
    if (!state?.site) return;
    setSlugValue(state.site.slug);
    setEditingSlug(true);
    setError("");
  };

  const saveSlug = () => {
    const candidate = slugValue.trim();
    if (!candidate) {
      setError("Введите название сайта");
      return;
    }
    void run("slug", async () => {
      await updateHostingSlug(projectId, candidate);
      setEditingSlug(false);
    });
  };

  const publish = () => run("publish", () => publishHosting(projectId));
  const rollback = (release: HostingRelease) => {
    if (!window.confirm("Переключить сайт на релиз " + release.id.slice(0, 8) + "? Текущая версия останется в истории.")) return;
    void run("rollback", () => rollbackHosting(projectId, release.id));
  };
  const unpublish = () => {
    if (!window.confirm("Снять сайт с публикации? Старые релизы останутся на диске до очистки.")) return;
    void run("unpublish", () => unpublishHosting(projectId));
  };
  const remove = () => {
    if (!window.confirm("Удалить сайт и все его релизы? Адрес перестанет открываться, отменить это нельзя.")) return;
    void run("delete", () => deleteHosting(projectId));
  };

  const openLog = async (release: HostingRelease) => {
    try {
      const result = await getHostingReleaseLog(projectId, release.id);
      setLog({ releaseId: release.id, text: [result.error, result.buildLog].filter(Boolean).join("\n\n") || "Лог пуст" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Не удалось скопировать адрес");
    }
  };

  const site = state?.site && state.site.status !== "deleted" ? state.site : null;
  const building = Boolean(site?.publishingReleaseId) || Boolean(state?.releases.some(release => release.status === "building"));
  const latestFailed = state?.releases.find(release => release.status === "failed");
  const failedLog = latestFailed && log?.releaseId === latestFailed.id ? log.text : "";

  return <section className="hosting-panel panel">
    <div className="panel-title hosting-head">
      <div className="panel-title-strong">
        <Globe2 size={15}/>
        <strong>Хостинг</strong>
      </div>
      <div className="hosting-head-actions">
        <button className="ghost-button" onClick={() => void load()} disabled={loading || Boolean(busy)} title="Перечитать состояние">
          <RefreshCw size={13} className={loading ? "spin" : ""}/> Обновить
        </button>
      </div>
    </div>

    <div className="hosting-scroll">
      {loading && !state ? <div className="hosting-empty"><Loader2 size={18} className="spin"/><span>Читаем состояние сайта…</span></div> : null}

      {error ? <div className="hosting-alert error"><AlertTriangle size={14}/><span>{error}</span></div> : null}

      {state && !state.enabled ? <div className="hosting-alert warn">
        <ShieldCheck size={14}/>
        <span>Публикация новых версий временно выключена администратором. Уже опубликованные сайты продолжают работать.</span>
      </div> : null}

      {!loading && state && !site ? <div className="hosting-hero">
        <div className="hosting-hero-icon"><Globe2 size={28}/></div>
        <div>
          <span className="hosting-kicker">Статический хостинг</span>
          <h2>Сайт по адресу <em>{state.domain}</em></h2>
          <p>Соберём проект в изолированной песочнице и отдадим готовые файлы через HTTPS. Подходит для Vite, React, готового HTML и других статических сборок.</p>
        </div>
        <label className="hosting-name-field">
          <span>Название сайта</span>
          <div className="hosting-name-box">
            <input
              value={newSlug}
              onChange={event => setNewSlug(event.target.value)}
              placeholder="moy-sayt"
              maxLength={63}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
            />
            <span>.{state.domain}</span>
          </div>
          <small>Латиница, цифры и дефис, 3–63 символа. Например: moy-sayt. Адрес можно будет поменять.</small>
        </label>
        <div className="hosting-hero-facts">
          <span><Rocket size={13}/> до {Math.round(state.limits.maxReleaseBytes / 1024 / 1024)} МБ</span>
          <span><FileCode2 size={13}/> до {state.limits.maxFiles.toLocaleString("ru-RU")} файлов</span>
          <span><Clock3 size={13}/> храним {state.limits.keepReleases} версии</span>
        </div>
        <button className="primary-button hosting-primary" onClick={() => void createAndPublish()} disabled={!state.enabled || Boolean(busy) || !newSlug.trim()}>
          {busy === "create" || busy === "publish" ? <Loader2 size={14} className="spin"/> : <Rocket size={14}/>} Опубликовать сайт
        </button>
      </div> : null}

      {site ? <>
        <div className="hosting-site-card">
          <div className="hosting-site-top">
            <div>
              <span className="hosting-kicker">Адрес сайта</span>
              {editingSlug ? <div className="hosting-slug-editor">
                <div className="hosting-slug-input">
                  <input
                    autoFocus
                    value={slugValue}
                    onChange={event => setSlugValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") { event.preventDefault(); saveSlug(); }
                      if (event.key === "Escape") { setEditingSlug(false); setError(""); }
                    }}
                    maxLength={63}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    aria-label="Название сайта"
                    disabled={busy === "slug"}
                  />
                  <span>.{state?.domain}</span>
                </div>
                <button className="ghost-button" onClick={saveSlug} disabled={Boolean(busy)}>
                  {busy === "slug" ? <Loader2 size={12} className="spin"/> : <Check size={12}/>} Сохранить
                </button>
                <button className="icon-button" title="Отмена" aria-label="Отмена" onClick={() => { setEditingSlug(false); setError(""); }} disabled={busy === "slug"}><X size={13}/></button>
                <small>Старый адрес перестанет открываться. Новый заработает автоматически.</small>
              </div> : <div className="hosting-url-row">
                {site.url
                  ? <a href={site.url} target="_blank" rel="noreferrer" className="hosting-url">{site.url.replace(/^https?:\/\//, "")}<ExternalLink size={12}/></a>
                  : <span className="hosting-url muted">{site.slug}.{state?.domain}</span>}
                {site.url ? <button className="icon-button" title="Скопировать адрес" aria-label="Скопировать адрес" onClick={() => void copyUrl(site.url!)}>{copied ? <Check size={13}/> : <Copy size={13}/>}</button> : null}
                <button className="ghost-button hosting-edit-address" title="Изменить адрес" onClick={startEditSlug} disabled={Boolean(busy) || building}><Pencil size={12}/> Изменить</button>
              </div>}
            </div>
            <span className={"hosting-badge " + site.status}>{statusLabel(site.status)}</span>
          </div>
          <div className="hosting-meta">
            <span>Релиз: <strong>{site.activeReleaseId ? shortId(site.activeReleaseId) : "нет"}</strong></span>
            <span>Обновлён: <strong>{formatDate(site.updatedAt)}</strong></span>
            <span>Хранилище: <strong>{formatBytes(state?.releases.filter(release => release.status === "ready").reduce((sum, release) => sum + release.bytes, 0) ?? 0)}</strong></span>
          </div>
          {site.suspendReason ? <div className="hosting-note danger"><AlertTriangle size={13}/> Сайт приостановлен: {site.suspendReason}</div> : null}
          {site.lastError ? <div className="hosting-note error"><AlertTriangle size={13}/> Последняя ошибка: {site.lastError}</div> : null}
          {building ? <div className="hosting-building"><Loader2 size={14} className="spin"/> Собираем и проверяем файлы. Это может занять несколько минут.</div> : null}
          <div className="hosting-actions">
            {site.status === "suspended" ? <span className="hosting-muted">Публикация недоступна до восстановления администратором.</span> : <>
              <button className="primary-button" onClick={() => void publish()} disabled={!state?.enabled || building || Boolean(busy)}>
                {building ? <Loader2 size={14} className="spin"/> : <Rocket size={14}/>} {site.activeReleaseId ? "Опубликовать заново" : "Опубликовать"}
              </button>
              {site.status === "live" ? <button className="ghost-button" onClick={unpublish} disabled={building || Boolean(busy)}><EyeOff size={13}/> Снять с публикации</button> : null}
            </>}
            <button className="ghost-button danger" onClick={remove} disabled={Boolean(busy)}><Trash2 size={13}/> Удалить сайт</button>
          </div>
        </div>

        {state?.releases.length ? <div className="hosting-releases">
          <div className="hosting-section-head"><strong>История публикаций</strong><span>{state.releases.length} из {state.limits.keepReleases} хранимых</span></div>
          <div className="hosting-release-list">
            {state.releases.map(release => <div className={"hosting-release " + (release.id === site.activeReleaseId ? "active" : "")} key={release.id}>
              <div className="hosting-release-main">
                <span className={"hosting-dot " + release.status}/>
                <div>
                  <strong>{release.id === site.activeReleaseId ? "Активная версия" : release.status === "failed" ? "Неудачная сборка" : "Релиз " + shortId(release.id)}</strong>
                  <span>{formatDate(release.createdAt)} · {release.files} файлов · {formatBytes(release.bytes)}</span>
                </div>
              </div>
              <div className="hosting-release-actions">
                <span className={"hosting-status " + release.status}>{releaseStatusLabel(release.status)}</span>
                {site.status === "live" && release.status === "ready" && release.id !== site.activeReleaseId ? <button className="ghost-button" onClick={() => rollback(release)} disabled={building || Boolean(busy)}>Вернуть</button> : null}
                {release.status === "failed" ? <button className="ghost-button" onClick={() => void openLog(release)}>Лог</button> : null}
              </div>
            </div>)}
          </div>
          {failedLog ? <pre className="hosting-log">{failedLog}</pre> : null}
        </div> : null}
      </> : null}

      {state ? <p className="hosting-footnote">Файлы отдаются напрямую, без PHP и серверного процесса. Секреты проекта в публичную сборку не передаются; `.env`, `.git` и символические ссылки не попадают в релиз.</p> : null}
    </div>
  </section>;
}

function statusLabel(status: "draft" | "live" | "unpublished" | "suspended" | "deleted") {
  if (status === "live") return "Опубликован";
  if (status === "draft") return "Черновик";
  if (status === "unpublished") return "Снят";
  if (status === "suspended") return "Приостановлен";
  return "Удалён";
}

function releaseStatusLabel(status: HostingRelease["status"]) {
  if (status === "ready") return "Готов";
  if (status === "building") return "Собирается";
  if (status === "failed") return "Ошибка";
  return "Удалён";
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 Б";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
  return (bytes / 1024 / 1024).toFixed(1) + " МБ";
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
