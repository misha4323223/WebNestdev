import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, CloudDownload, CloudOff, CloudUpload, ExternalLink, FileCode,
  GitBranch, History, Loader2, Plus, RefreshCw, RotateCcw, Send,
} from "lucide-react";
import {
  commitProjectWorktree, createProjectBranch, getProjectChanges, getProjectDiff, getProjectWorktree,
  listProjectBranches, pullProjectChanges, pushProjectChanges, rollbackProjectChanges, switchProjectBranch,
  type ChangeCheckpoint, type ProjectBranches, type ProjectChanges, type ProjectFileDiff, type ProjectWorktree,
} from "../../lib/project-api";
import { apiUrl } from "../../lib/api";
import { createProjectRepository, getGitHubStatus } from "../../lib/github-api";
import { Hint } from "../../components/Hint";

/**
 * Git-панель проекта — по образцу панели Replit: ветка и синхронизация сверху, рабочие
 * изменения с выбором файлов и сообщением коммита, ниже — история.
 *
 * Главное отличие от прежних «Изменений»: здесь можно закоммитить правку, сделанную руками в
 * «Файлах» или в терминале, не дожидаясь задачи агента. Пуш по-прежнему никогда не происходит
 * сам: его включает человек галочкой «Отправить» — это действие меняет чужой репозиторий.
 */

type Busy = "" | "push" | "pull" | "commit" | "rollback" | "repository" | "branch" | "switch";

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return count + " " + one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return count + " " + few;
  return count + " " + many;
}

function filesLabel(count: number) { return plural(count, "файл", "файла", "файлов"); }
function pointsLabel(count: number) { return plural(count, "точка", "точки", "точек"); }

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
  manual: "вручную",
};

const fileMark: Record<"added" | "modified" | "deleted", string> = {
  added: "+",
  modified: "±",
  deleted: "−",
};

const statusLabel: Record<"added" | "modified" | "deleted", string> = {
  added: "новый",
  modified: "изменён",
  deleted: "удалён",
};

type DiffState = { loading: boolean; patch: string; error?: string; binary?: boolean; truncated?: boolean };

/** Строки diff красятся по первому символу — сам патч приходит текстом и в HTML не вставляется. */
function DiffView({ diff }: { diff: DiffState }) {
  if (diff.loading) return <div className="git-diff-state"><Loader2 size={13} className="spin"/> Читаем diff…</div>;
  if (diff.error) return <div className="git-diff-state warn">{diff.error}</div>;
  if (diff.binary) return <div className="git-diff-state">Двоичный файл: diff не строится.</div>;
  if (diff.truncated) return <div className="git-diff-state">Файл слишком большой для построчного diff.</div>;
  if (!diff.patch) return <div className="git-diff-state">Содержимое не изменилось.</div>;
  return <pre className="git-diff" aria-label="Разница версий файла">
    {diff.patch.split("\n").map((line, index) => {
      const tone = line.startsWith("@@") ? "hunk"
        : line.startsWith("+++") || line.startsWith("---") ? "meta"
          : line.startsWith("+") ? "add"
            : line.startsWith("-") ? "del" : "ctx";
      return <span className={tone} key={index}>{line || " "}</span>;
    })}
  </pre>;
}

export function ChangesPanel({ projectId, projectName, onRolledBack }: { projectId: string; projectName?: string; onRolledBack?: () => void }) {
  const [data, setData] = useState<ProjectChanges | null>(null);
  const [worktree, setWorktree] = useState<ProjectWorktree | null>(null);
  const [branches, setBranches] = useState<ProjectBranches | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Busy>("");
  const [gitHub, setGitHub] = useState<{ connected: boolean } | null>(null);
  const [repoName, setRepoName] = useState(projectName ?? "");
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [pushAfter, setPushAfter] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [expanded, setExpanded] = useState<string>("");
  const [openDiff, setOpenDiff] = useState<string>("");
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const [confirming, setConfirming] = useState("");
  const branchDetails = useRef<HTMLDetailsElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [overview, tree, branchList] = await Promise.all([
        getProjectChanges(projectId),
        getProjectWorktree(projectId).catch(() => null),
        listProjectBranches(projectId).catch(() => null),
      ]);
      setData(overview);
      setWorktree(tree);
      setBranches(branchList);
      setSelected(new Set(tree?.files.map(file => file.path) ?? []));
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

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(""), 6000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const checkpoints = data?.checkpoints ?? [];
  const currentSha = checkpoints[0]?.sha;
  const repository = data?.repository;
  const providerName = repository?.provider === "gitlab" ? "GitLab" : repository?.provider === "gitverse" ? "GitVerse" : repository?.provider === "sourcecraft" ? "SourceCraft" : "GitHub";
  const changedFiles = worktree?.files ?? [];
  const selectedFiles = changedFiles.filter(file => selected.has(file.path));
  const canCommit = Boolean(message.trim()) && selectedFiles.length > 0 && !busy;

  const push = async () => {
    setBusy("push"); setNotice(null);
    try {
      const result = await pushProjectChanges(projectId);
      setNotice({ kind: "ok", text: "Изменения отправлены в " + result.branch + " на " + providerName + "." });
      await load();
    } catch (pushError) {
      setNotice({ kind: "warn", text: pushError instanceof Error ? pushError.message : String(pushError) });
    } finally { setBusy(""); }
  };

  const pull = async () => {
    setBusy("pull"); setNotice(null);
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
      setDiffs({}); setOpenDiff("");
      await load();
      onRolledBack?.();
    } catch (pullError) {
      setNotice({ kind: "warn", text: pullError instanceof Error ? pullError.message : String(pullError) });
    } finally { setBusy(""); }
  };

  const commit = async () => {
    if (!canCommit) return;
    setBusy("commit"); setNotice(null);
    try {
      const result = await commitProjectWorktree(projectId, {
        message: message.trim(),
        paths: selectedFiles.map(file => file.path),
        ...(pushAfter && repository?.connected ? { push: true } : {}),
      });
      setData(result.overview);
      setMessage("");
      setPushAfter(false);
      setOpenDiff("");
      setDiffs({});
      await load();
      const pushedText = result.pushed
        ? " и отправлены в ветку " + result.branch + " на " + providerName
        : pushAfter && result.pushError ? ", но отправить не удалось: " + result.pushError : "";
      setNotice({
        kind: result.pushError ? "warn" : "ok",
        text: "Закоммичено " + filesLabel(result.checkpoint.filesChanged) + pushedText + ".",
      });
      onRolledBack?.();
    } catch (commitError) {
      setNotice({ kind: "warn", text: commitError instanceof Error ? commitError.message : String(commitError) });
    } finally { setBusy(""); }
  };

  const createRepository = async () => {
    setBusy("repository"); setNotice(null);
    try {
      const result = await createProjectRepository(projectId, repoName.trim() || projectName || "");
      setData(result.overview);
      setNotice({
        kind: result.pushed ? "ok" : "warn",
        text: result.pushed
          ? "Репозиторий создан, проект отправлен в ветку " + result.branch + "."
          : "Репозиторий создан, но отправить проект не удалось: " + (result.pushError ?? "неизвестная причина"),
      });
      await load();
    } catch (repositoryError) {
      setNotice({ kind: "warn", text: repositoryError instanceof Error ? repositoryError.message : String(repositoryError) });
    } finally { setBusy(""); }
  };

  const switchTo = async (branch: string) => {
    branchDetails.current?.removeAttribute("open");
    if (branch === repository?.branch) return;
    setBusy("switch"); setNotice(null);
    try {
      const result = await switchProjectBranch(projectId, branch);
      if (!result.switched) {
        setNotice({ kind: "warn", text: result.error ?? "Не удалось переключить ветку." });
        return;
      }
      setData(result.overview);
      setNotice({ kind: "ok", text: "Проект переключён на ветку " + result.branch + "." });
      setDiffs({}); setOpenDiff("");
      await load();
      onRolledBack?.();
    } catch (switchError) {
      setNotice({ kind: "warn", text: switchError instanceof Error ? switchError.message : String(switchError) });
    } finally { setBusy(""); }
  };

  const addBranch = async () => {
    const name = newBranch.trim();
    if (!name) return;
    setBusy("branch"); setNotice(null);
    try {
      const result = await createProjectBranch(projectId, name);
      setNewBranch("");
      setData(result.overview);
      setNotice({ kind: "ok", text: "Ветка " + result.branch + " создана — следующие коммиты уйдут в неё." });
      await load();
    } catch (branchError) {
      setNotice({ kind: "warn", text: branchError instanceof Error ? branchError.message : String(branchError) });
    } finally { setBusy(""); }
  };

  const rollback = async (checkpoint: ChangeCheckpoint) => {
    if (confirming !== checkpoint.sha) { setConfirming(checkpoint.sha); return; }
    setConfirming("");
    setBusy("rollback"); setNotice(null);
    try {
      const result = await rollbackProjectChanges(projectId, checkpoint.sha);
      setNotice({
        kind: "ok",
        text: repository?.connected
          ? "Проект возвращён к " + checkpoint.shortSha + ". Отправьте точку на " + providerName + " кнопкой, когда убедитесь в результате."
          : "Проект возвращён к " + checkpoint.shortSha + ". История осталась в проекте — " + providerName + " не подключён.",
      });
      setData(result.overview);
      setDiffs({}); setOpenDiff("");
      await load();
      onRolledBack?.();
    } catch (rollbackError) {
      setNotice({ kind: "warn", text: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
    } finally { setBusy(""); }
  };

  function toggleSelected(path: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function showDiff(key: string, file: string, sha?: string) {
    if (openDiff === key) { setOpenDiff(""); return; }
    setOpenDiff(key);
    if (diffs[key] && !diffs[key].error) return;
    setDiffs(current => ({ ...current, [key]: { loading: true, patch: "" } }));
    try {
      const result: ProjectFileDiff = await getProjectDiff(projectId, file, sha);
      setDiffs(current => ({
        ...current,
        [key]: { loading: false, patch: result.patch, ...(result.binary ? { binary: true } : {}), ...(result.truncated ? { truncated: true } : {}) },
      }));
    } catch (diffError) {
      setDiffs(current => ({ ...current, [key]: { loading: false, patch: "", error: diffError instanceof Error ? diffError.message : String(diffError) } }));
    }
  }

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

  return <section className="changes-panel git-panel">
    <div className="panel-title">
      <div><span className="eyebrow">GIT</span><span className="panel-title-strong"><strong>Репозиторий проекта</strong><Hint label="Git проекта">История версий и отправка на GitHub.</Hint></span></div>
      <div className="changes-actions">
        {repository?.connected && <button className="ghost-button changes-sync" onClick={() => void pull()} disabled={Boolean(busy)} title={"Забрать ветку из " + providerName + " в проект"}>
          <CloudDownload size={14}/> {busy === "pull" ? "Выгружаем…" : <><span className="changes-label-full">Выгрузить</span><span className="changes-label-short">Pull</span></>}
        </button>}
        {repository?.connected && <button className="ghost-button changes-sync" onClick={() => void push()} disabled={Boolean(busy)} title={"Отправить текущую ветку на " + providerName}>
          <CloudUpload size={14}/> {busy === "push" ? "Отправляем…" : <><span className="changes-label-full">Отправить</span><span className="changes-label-short">Push</span></>}
        </button>}
        <button className="ghost-button" onClick={() => void load()} disabled={loading} title="Обновить состояние"><RefreshCw size={14}/> Обновить</button>
      </div>
    </div>

    <div className="changes-scroll">
      <div className="changes-repo git-repo">
        <div className="changes-repo-main">
          <details className="git-branch" ref={branchDetails}>
            <summary title="Ветки проекта"><GitBranch size={14}/><span className="changes-branch">{repository?.branch ?? "main"}</span><ChevronDown size={12}/></summary>
            <div className="git-branch-menu" role="menu" aria-label="Ветки проекта">
              <div className="git-branch-menu-head">Ветки</div>
              {(branches?.branches ?? []).map(branch => <button
                key={branch.name}
                className={"git-branch-item" + (branch.name === repository?.branch ? " current" : "")}
                onClick={() => void switchTo(branch.name)}
                disabled={Boolean(busy)}
                role="menuitem"
              >
                <span>{branch.name}</span>
                {branch.name === repository?.branch ? <Check size={12}/> : branch.remote ? <CloudUpload size={11}/> : null}
              </button>)}
              {!branches?.branches.length && <span className="git-branch-empty">Веток пока нет</span>}
              <div className="git-branch-new">
                <input
                  value={newBranch}
                  onChange={event => setNewBranch(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") void addBranch(); }}
                  placeholder="новая ветка"
                  aria-label="Имя новой ветки"
                  spellCheck={false}
                />
                <button onClick={() => void addBranch()} disabled={!newBranch.trim() || Boolean(busy)} title="Создать ветку от текущего состояния" aria-label="Создать ветку">
                  {busy === "branch" ? <Loader2 size={12} className="spin"/> : <Plus size={12}/>}
                </button>
              </div>
            </div>
          </details>
          {repository?.remoteUrl
            ? <a className="changes-repo-link" href={repository.remoteUrl.replace(/\.git$/, "")} target="_blank" rel="noreferrer">{repository.remoteUrl.replace(/^https?:\/\//, "").replace(/\.git$/, "")}</a>
            : <span className="changes-repo-hint">локальная история — репозиторий не подключён</span>}
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
          <strong>{providerName} не подключён</strong>
          <span>История хранится в проекте. Подключите репозиторий, чтобы отправлять коммиты в ветку {repository.branch}.</span>
        </div>
        {gitHub?.connected
          ? <div className="changes-connect-form">
              <input value={repoName} onChange={event => setRepoName(event.target.value)} placeholder="имя репозитория" maxLength={100} aria-label={"Имя репозитория на " + providerName}/>
              <button className="send-button" onClick={() => void createRepository()} disabled={Boolean(busy)}>{busy === "repository" ? "Создаём…" : "Создать и отправить"}</button>
            </div>
          : <button className="ghost-button changes-connect-button" onClick={() => { window.location.href = apiUrl("/api/github/connect?origin=" + encodeURIComponent(window.location.origin)); }}>Подключить GitHub</button>}
      </div>}

      {notice && <div className={"changes-notice " + notice.kind} role="status">{notice.text}</div>}
      {error && <div className="changes-notice warn" role="alert">{error}</div>}
      {loading && !data && <div className="changes-empty">Загружаем состояние репозитория…</div>}

      {!loading && data && <div className="git-card">
        <div className="git-card-head">
          <div className="git-card-title"><FileCode size={13}/> Рабочие изменения <b>{changedFiles.length}</b><Hint label="Рабочие изменения">Файлы, которые ещё не попали в историю.</Hint></div>
          {changedFiles.length > 0 && <div className="git-card-tools">
            <button className="git-link-button" onClick={() => setSelected(new Set(changedFiles.map(file => file.path)))}>Выбрать все</button>
            {selected.size > 0 && <button className="git-link-button" onClick={() => setSelected(new Set())}>Снять</button>}
          </div>}
        </div>
        {!changedFiles.length
          ? <div className="git-clean"><Check size={13}/> Рабочее дерево чистое: все правки уже в истории.</div>
          : <>
              <ul className="git-change-list">
                {changedFiles.map(file => {
                  const key = "worktree:" + file.path;
                  const open = openDiff === key;
                  return <li className="git-change" key={file.path}>
                    <label className="git-check" title="Включить файл в коммит">
                      <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggleSelected(file.path)} aria-label={"Включить " + file.path + " в коммит"}/>
                      <span className={"git-status " + file.status} title={statusLabel[file.status]}>{fileMark[file.status]}</span>
                    </label>
                    <button className="git-change-path" onClick={() => void showDiff(key, file.path)} title="Показать diff">
                      <span>{file.path}</span>
                      <span className={"git-status-text " + file.status}>{statusLabel[file.status]}</span>
                    </button>
                    <button className="git-diff-toggle" onClick={() => void showDiff(key, file.path)} aria-expanded={open} title={open ? "Скрыть diff" : "Показать diff"}>
                      {open ? <ChevronDown size={13}/> : <ChevronDown size={13} className="git-chevron-right"/>}
                    </button>
                    {open && <div className="git-diff-wrap"><DiffView diff={diffs[key] ?? { loading: true, patch: "" }}/></div>}
                  </li>;
                })}
              </ul>
              <div className="git-commit">
                <textarea
                  value={message}
                  onChange={event => setMessage(event.target.value)}
                  placeholder="Что изменилось и зачем — сообщение коммита"
                  maxLength={500}
                  rows={2}
                  aria-label="Сообщение коммита"
                />
                <div className="git-commit-actions">
                  <label className={"git-push-choice" + (repository?.connected ? "" : " disabled")} title={repository?.connected ? "После коммита отправить ветку в репозиторий" : "Репозиторий не подключён"}>
                    <input type="checkbox" checked={pushAfter} onChange={event => setPushAfter(event.target.checked)} disabled={!repository?.connected}/>
                    <Send size={11}/> Отправить
                  </label>
                  <span className="git-selected">{selectedFiles.length} из {changedFiles.length} {filesLabel(changedFiles.length)}</span>
                  <button className="git-commit-btn" onClick={() => void commit()} disabled={!canCommit}>
                    {busy === "commit" ? <><Loader2 size={12} className="spin"/> Коммитим…</> : pushAfter && repository?.connected ? "Закоммитить и отправить" : "Закоммитить"}
                  </button>
                </div>
              </div>
            </>}
      </div>}

      <div className="git-card git-history-card">
        <div className="git-card-head">
          <div className="git-card-title"><History size={13}/> История <b>{checkpoints.length}</b><Hint label="История версий">Точки, к которым можно вернуться.</Hint></div>
          <span className="git-card-hint">{headline}</span>
        </div>

        {!loading && data && !data.initialized && <div className="changes-empty">
          <History size={22}/>
          <strong>История появится после первого коммита</strong>
          <span>Закоммитьте изменения выше или завершите задачу агента.</span>
        </div>}

        {data?.initialized && !checkpoints.length && <div className="changes-empty"><History size={22}/><strong>Точек пока нет</strong><span>Первый коммит появится здесь.</span></div>}

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
                    ? <span className="change-push ok" title={"Коммит есть в ветке на " + providerName}><CloudUpload size={11}/> в {providerName}</span>
                    : repository?.connected
                      ? <span className="change-push pending" title="Коммит ещё не отправлен"><CloudOff size={11}/> не отправлено</span>
                      : null}
                </div>
                <div className="change-meta">
                  <code>{checkpoint.shortSha}</code>
                  <span>{formatTime(checkpoint.createdAt)}</span>
                  <span>{filesLabel(checkpoint.filesChanged)}</span>
                  {checkpoint.revertedTo && <span className="change-reverted">из {checkpoint.revertedTo.slice(0, 7)}</span>}
                </div>
                {checkpoint.files.length > 0 && open && <ul className="change-files git-history-files">
                  {checkpoint.files.map(file => {
                    const key = checkpoint.sha + ":" + file.path;
                    const fileOpen = openDiff === key;
                    return <li className="git-history-file" key={file.status + file.path}>
                      <button className="change-file git-history-file-button" onClick={() => void showDiff(key, file.path, checkpoint.sha)} aria-expanded={fileOpen}>
                        <span className={"change-file-mark " + file.status}>{fileMark[file.status]}</span>
                        <span className="change-file-path">{file.path}</span>
                        <ChevronDown size={11} className={fileOpen ? "" : "git-chevron-right"}/>
                      </button>
                      {fileOpen && <div className="git-diff-wrap"><DiffView diff={diffs[key] ?? { loading: true, patch: "" }}/></div>}
                    </li>;
                  })}
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
                  <AlertTriangle size={12}/> Текущая версия сохранится в истории: откат создаёт новую точку. На {providerName} она уйдёт только по кнопке «Отправить».
                </div>}
              </div>
            </li>;
          })}
        </ol>}

        {data?.initialized && checkpoints.length > 0 && <p className="changes-footnote">{headline}. Откат не удаляет историю: он добавляет новую точку, поэтому вернуться назад можно в любой момент.</p>}
      </div>
    </div>
  </section>;
}
