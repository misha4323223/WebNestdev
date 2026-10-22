import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CloudDownload, CloudOff, CloudUpload, ExternalLink, FileCode, GitBranch, History, RefreshCw, RotateCcw } from "lucide-react";
import { getProjectChanges, pullProjectChanges, pushProjectChanges, rollbackProjectChanges, type ChangeCheckpoint, type ProjectChanges } from "../../lib/project-api";
import { apiUrl } from "../../lib/api";
import { createProjectRepository, getGitHubStatus } from "../../lib/github-api";

/**
 * «Изменения» — история задач проекта. Точка появляется сама после выполненной задачи: агент
 * записывает проверенное состояние в историю. На GitHub ничего не уходит само — отправку
 * запускает пользователь кнопкой, потому что пуш меняет чужой репозиторий.
 */

/** Русское склонение для счётчиков: «1 файл», «2 файла», «5 файлов» и так же для точек. */
function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return count + " " + one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return count + " " + few;
  return count + " " + many;
}

function filesLabel(count: number) {
  return plural(count, "файл", "файла", "файлов");
}

function pointsLabel(count: number) {
  return plural(count, "точка", "точки", "точек");
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return "сегодня, " + date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + ", " +
    date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

const kindLabel: Record<ChangeCheckpoint["kind"], string> = {
  task: "задача",
  rollback: "откат",
  imported: "начальное",
};

const fileMark: Record<ChangeCheckpoint["files"][number]["status"], string> = {
  added: "+",
  modified: "±",
  deleted: "−",
};

export function ChangesPanel({ projectId, projectName, onRolledBack }: { projectId: string; projectName?: string; onRolledBack?: () => void }) {
  const [data, setData] = useState<ProjectChanges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "push" | "pull" | "rollback" | "repository">("");
  // Репозиторий создаётся из «Изменений»: это то место, куда отправляются коммиты, и без
  // репозитория проект, созданный в приложении, не может отправить ничего.
  const [gitHub, setGitHub] = useState<{ connected: boolean } | null>(null);
  const [repoName, setRepoName] = useState(projectName ?? "");
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [expanded, setExpanded] = useState<string>("");
  const [confirming, setConfirming] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await getProjectChanges(projectId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    void getGitHubStatus()
      .then(status => { if (active) setGitHub({ connected: Boolean(status.connected) }); })
      .catch(() => { if (active) setGitHub({ connected: false }); });
    return () => { active = false; };
  }, []);

  // Подтверждение отката живёт несколько секунд: случайно оставленное «Точно вернуть?»
  // не должно сработать через минуту, когда пользователь уже думает о другом.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(""), 6000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const checkpoints = data?.checkpoints ?? [];
  const currentSha = checkpoints[0]?.sha;
  const repository = data?.repository;
  // Проект помнит, откуда он импортирован: GitLab-репозиторий не должен называться GitHub.
  const providerName = repository?.provider === "gitlab" ? "GitLab" : "GitHub";

  const push = async () => {
    setBusy("push");
    setNotice(null);
    try {
      const result = await pushProjectChanges(projectId);
      setNotice({ kind: "ok", text: "Изменения отправлены в " + result.branch + " на " + providerName + "." });
      await load();
    } catch (pushError) {
      setNotice({ kind: "warn", text: pushError instanceof Error ? pushError.message : String(pushError) });
    } finally {
      setBusy("");
    }
  };

  /**
   * Выгрузка из GitHub. Отказ fast-forward — не ошибка панели, а ответ: в проекте есть точки,
   * которых нет на GitHub, и перезаписывать их нельзя. Показывается тем же уведомлением.
   */
  const pull = async () => {
    setBusy("pull");
    setNotice(null);
    try {
      const result = await pullProjectChanges(projectId);
      setData(result.overview);
      if (!result.pulled) {
        setNotice({ kind: "warn", text: result.error ?? "Не удалось выгрузить изменения из " + providerName + "." });
        return;
      }
      setNotice({
        kind: "ok",
        text: result.changed
          ? "Выгружено из ветки " + result.branch + " на " + providerName + ": обновлено " + filesLabel(result.changed) + "."
          : "Проект уже совпадает с веткой " + result.branch + " на " + providerName + " — выгружать нечего.",
      });
      onRolledBack?.();
    } catch (pullError) {
      setNotice({ kind: "warn", text: pullError instanceof Error ? pullError.message : String(pullError) });
    } finally {
      setBusy("");
    }
  };

  const createRepository = async () => {
    setBusy("repository");
    setNotice(null);
    try {
      const result = await createProjectRepository(projectId, repoName.trim() || projectName || "");
      setData(result.overview);
      setNotice({
        kind: result.pushed ? "ok" : "warn",
        text: result.pushed
          ? "Репозиторий создан, проект отправлен в ветку " + result.branch + "."
          : "Репозиторий создан, но отправить проект не удалось: " + (result.pushError ?? "неизвестная причина"),
      });
    } catch (repositoryError) {
      setNotice({ kind: "warn", text: repositoryError instanceof Error ? repositoryError.message : String(repositoryError) });
    } finally {
      setBusy("");
    }
  };

  const rollback = async (checkpoint: ChangeCheckpoint) => {
    if (confirming !== checkpoint.sha) {
      setConfirming(checkpoint.sha);
      return;
    }
    setConfirming("");
    setBusy("rollback");
    setNotice(null);
    try {
      const result = await rollbackProjectChanges(projectId, checkpoint.sha);
      // Откат тоже не пушится сам: сначала надо убедиться, что вернулось именно то состояние.
      setNotice({
        kind: "ok",
        text: repository?.connected
          ? "Проект возвращён к " + checkpoint.shortSha + ". Отправьте точку на " + providerName + " кнопкой, когда убедитесь в результате."
          : "Проект возвращён к " + checkpoint.shortSha + ". История осталась в проекте — " + providerName + " не подключён.",
      });
      setData(result.overview);
      onRolledBack?.();
    } catch (rollbackError) {
      setNotice({ kind: "warn", text: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
    } finally {
      setBusy("");
    }
  };

  const headline = useMemo(() => {
    if (!data?.initialized) return "История ещё не создана";
    if (!checkpoints.length) return "Изменений пока нет";
    return pointsLabel(checkpoints.length) + " в истории";
  }, [data, checkpoints.length]);

  const pushState = repository?.lastPushError
    ? { tone: "warn" as const, text: repository.lastPushError }
    : repository?.lastPushAt
      ? { tone: "ok" as const, text: "последняя отправка " + formatTime(repository.lastPushAt) }
      : null;

  return <section className="changes-panel">
    <div className="panel-title">
      <div><span className="eyebrow">ИСТОРИЯ</span><strong>Изменения проекта</strong></div>
      <div className="changes-actions">
        {repository?.connected && <button className="ghost-button changes-sync" onClick={() => void pull()} disabled={Boolean(busy)} title={"Забрать ветку из " + providerName + " в проект"}>
          <CloudDownload size={14}/> {busy === "pull" ? "Выгружаем…" : <><span className="changes-label-full">Выгрузить из {providerName}</span><span className="changes-label-short">Выгрузить</span></>}
        </button>}
        {repository?.connected && checkpoints.length > 0 && <button className="ghost-button changes-sync" onClick={() => void push()} disabled={Boolean(busy)} title={"Отправить текущую ветку на " + providerName}>
          <CloudUpload size={14}/> {busy === "push" ? "Отправляем…" : <><span className="changes-label-full">Отправить на {providerName}</span><span className="changes-label-short">Отправить</span></>}
        </button>}
        <button className="ghost-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14}/> Обновить</button>
      </div>
    </div>

    <div className="changes-scroll">
      <div className="changes-repo">
        <div className="changes-repo-main">
          <GitBranch size={14}/>
          <span className="changes-branch">{repository?.branch ?? "main"}</span>
          {repository?.remoteUrl
            ? <a className="changes-repo-link" href={repository.remoteUrl.replace(/\.git$/, "")} target="_blank" rel="noreferrer">{repository.remoteUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")}</a>
            : <span className="changes-repo-hint">репозиторий не подключён — история хранится в проекте</span>}
        </div>
        <div className="changes-repo-state">
          {repository?.connected
            ? <span className={"changes-state " + (repository.lastPushError ? "warn" : "ok")}>
                {repository.lastPushError ? <CloudOff size={12}/> : <CloudUpload size={12}/>}
                {pushState?.text ?? "готово к отправке"}
              </span>
            : <span className="changes-state muted">локальная история</span>}
        </div>
      </div>

      {repository && !repository.connected && <div className="changes-connect">
        <div className="changes-connect-text">
          <strong>GitHub не подключён</strong>
          <span>История хранится в проекте. Создайте репозиторий, чтобы отправлять точки в ветку {repository.branch} — вручную, кнопкой и только когда вы этого хотите.</span>
        </div>
        {gitHub?.connected
          ? <div className="changes-connect-form">
              <input value={repoName} onChange={event => setRepoName(event.target.value)} placeholder="имя репозитория" maxLength={100} aria-label="Имя репозитория на GitHub"/>
              <button className="send-button" onClick={() => void createRepository()} disabled={Boolean(busy)}>{busy === "repository" ? "Создаём…" : "Создать и отправить"}</button>
            </div>
          : <button className="ghost-button changes-connect-button" onClick={() => { window.location.href = apiUrl("/api/github/connect?origin=" + encodeURIComponent(window.location.origin)); }}>Подключить GitHub</button>}
      </div>}

      {notice && <div className={"changes-notice " + notice.kind} role="status">{notice.text}</div>}
      {error && <div className="changes-notice warn" role="alert">{error}</div>}

      {loading && !data && <div className="changes-empty">Загружаем историю…</div>}

      {!loading && data && !data.initialized && <div className="changes-empty">
        <History size={22}/>
        <strong>История появится после первой задачи</strong>
        <span>Когда агент закончит работу и проверки пройдут, состояние проекта станет точкой, к которой можно вернуться.</span>
        {!repository?.connected && <span className="changes-empty-hint">Подключите GitHub, чтобы отправлять точки в ветку {repository?.branch ?? "main"} — вручную и в любой момент.</span>}
      </div>}

      {data?.initialized && !checkpoints.length && <div className="changes-empty"><History size={22}/><strong>Точек пока нет</strong><span>Первая выполненная задача создаст первую точку.</span></div>}

      {checkpoints.length > 0 && <ol className="changes-list">
        {checkpoints.map(checkpoint => {
          const isCurrent = checkpoint.sha === currentSha;
          const open = expanded === checkpoint.sha;
          return <li className={"change-item" + (isCurrent ? " current" : "")} key={checkpoint.sha}>
            <span className={"change-dot " + checkpoint.kind} aria-hidden="true"/>
            <div className="change-body">
              <div className="change-head">
                <span className="change-subject" title={checkpoint.subject}>{checkpoint.subject}</span>
                <span className={"change-kind " + checkpoint.kind}>{kindLabel[checkpoint.kind]}</span>
                {isCurrent && <span className="change-kind current">сейчас</span>}
                {checkpoint.pushed
                  ? <span className="change-push ok" title={"Изменение есть в ветке на " + providerName}><CloudUpload size={11}/> в {providerName}</span>
                  : repository?.connected
                    ? <span className="change-push pending" title="Это изменение ещё не отправлено"><CloudOff size={11}/> не отправлено</span>
                    : null}
              </div>
              <div className="change-meta">
                <code>{checkpoint.shortSha}</code>
                <span>{formatTime(checkpoint.createdAt)}</span>
                <span>{filesLabel(checkpoint.filesChanged)}</span>
                {checkpoint.revertedTo && <span className="change-reverted">из {checkpoint.revertedTo.slice(0, 7)}</span>}
              </div>
              {checkpoint.files.length > 0 && open && <ul className="change-files">
                {checkpoint.files.map(file => <li className="change-file" key={file.status + file.path}>
                  <span className={"change-file-mark " + file.status}>{fileMark[file.status]}</span>
                  <span className="change-file-path">{file.path}</span>
                </li>)}
                {checkpoint.filesChanged > checkpoint.files.length && <li className="change-file more">и ещё {checkpoint.filesChanged - checkpoint.files.length}</li>}
              </ul>}
              <div className="change-actions">
                {checkpoint.files.length > 0 && <button className="ghost-button change-toggle" onClick={() => setExpanded(open ? "" : checkpoint.sha)}>
                  <FileCode size={13}/> {open ? "Скрыть файлы" : "Файлы (" + checkpoint.filesChanged + ")"}
                </button>}
                {!isCurrent && <button
                  className={"ghost-button change-rollback" + (confirming === checkpoint.sha ? " confirming" : "")}
                  onClick={() => void rollback(checkpoint)}
                  disabled={Boolean(busy)}
                  title={"Вернуть проект к состоянию " + checkpoint.shortSha}
                >
                  <RotateCcw size={13}/> {confirming === checkpoint.sha ? "Точно вернуть?" : "Вернуть"}
                </button>}
                {checkpoint.url && <a className="change-link" href={checkpoint.url} target="_blank" rel="noreferrer">коммит <ExternalLink size={11}/></a>}
              </div>
              {confirming === checkpoint.sha && <div className="change-confirm-hint">
                <AlertTriangle size={12}/> Текущая версия сохранится в истории: откат создаёт новую точку. На {providerName} она уйдёт только по кнопке «Отправить на {providerName}».
              </div>}
            </div>
          </li>;
        })}
      </ol>}

      {data?.initialized && checkpoints.length > 0 && <p className="changes-footnote">{headline}. Откат не удаляет историю: он добавляет новую точку, поэтому вернуться назад можно в любой момент.</p>}
    </div>
  </section>;
}
