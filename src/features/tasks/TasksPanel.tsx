import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ListChecks, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { addProjectTasks, getProjectTasks, removeProjectTask, toggleProjectTask, type ProjectTask, type ProjectTasks } from "../../lib/project-api";
import { copyText } from "../../lib/clipboard";
import { Hint } from "../../components/Hint";
import { NestLoader } from "../../components/NestLoader";

type TaskGroup = { key: string; title: string; tasks: ProjectTask[] };

export function TasksPanel({ projectId, reloadToken = 0 }: { projectId: string; reloadToken?: number }) {
  const [data, setData] = useState<ProjectTasks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyLine, setBusyLine] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [undo, setUndo] = useState<ProjectTask | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const undoTimer = useRef<number | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 3200);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await getProjectTasks(projectId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось загрузить задачи");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, reloadToken]);

  useEffect(() => () => {
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
  }, []);

  const groups = useMemo(() => {
    const order: TaskGroup[] = [];
    const byKey = new Map<string, TaskGroup>();
    for (const task of data?.tasks ?? []) {
      const key = task.section ?? "";
      let group = byKey.get(key);
      if (!group) {
        group = { key, title: task.section ?? "Без раздела", tasks: [] };
        byKey.set(key, group);
        order.push(group);
      }
      group.tasks.push(task);
    }
    return order;
  }, [data]);

  const progress = data && data.total > 0 ? Math.round(data.done / data.total * 100) : 0;
  const left = data ? data.total - data.done : 0;
  const showGroupHead = groups.length > 1 || Boolean(groups[0]?.key);

  function update(next: ProjectTasks) {
    setData(next);
    setError("");
  }

  async function toggle(task: ProjectTask) {
    if (!data || busyLine !== null) return;
    const done = !task.done;
    const optimistic: ProjectTasks = {
      ...data,
      tasks: data.tasks.map(item => item.line === task.line ? { ...item, done } : item),
      done: data.done + (done ? 1 : -1),
    };
    update(optimistic);
    setBusyLine(task.line);
    try {
      update(await toggleProjectTask(projectId, { line: task.line, done, revision: data.revision }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось изменить задачу");
      await load();
    } finally {
      setBusyLine(null);
    }
  }

  async function remove(task: ProjectTask) {
    if (!data || busyLine !== null) return;
    setBusyLine(task.line);
    setError("");
    try {
      update(await removeProjectTask(projectId, { line: task.line, revision: data.revision }));
      setUndo(task);
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => setUndo(null), 9000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось удалить задачу");
      await load();
    } finally {
      setBusyLine(null);
    }
  }

  async function undoRemove() {
    if (!undo || !data) return;
    const task = undo;
    setUndo(null);
    setBusyLine(task.line);
    setError("");
    try {
      update(await addProjectTasks(projectId, {
        items: [{ title: task.title, section: task.section ?? undefined, done: task.done }],
        revision: data.revision,
      }));
      showNotice("Задача восстановлена.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось восстановить задачу");
      await load();
    } finally {
      setBusyLine(null);
    }
  }

  async function add() {
    const title = draft.trim();
    if (!title || !data && loading || adding) return;
    setAdding(true);
    setError("");
    try {
      const next = await addProjectTasks(projectId, {
        items: [{ title }],
        ...(data?.revision ? { revision: data.revision } : {}),
      });
      update(next);
      setDraft("");
      if (!next.added) showNotice("Такая задача уже есть.");
      else showNotice("Задача добавлена.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось добавить задачу");
    } finally {
      setAdding(false);
    }
  }

  async function copy() {
    if (!data) return;
    const copiedOk = await copyText(data.markdown);
    if (!copiedOk) {
      setError("Не удалось скопировать: откройте TASKS.md во вкладке «Файлы».");
      return;
    }
    setCopied(true);
    showNotice("TASKS.md скопирован.");
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1800);
  }

  return <section className="tasks-panel">
    <div className="panel-title tasks-head">
      <div className="tasks-title">
        <span className="eyebrow">ЗАДАЧИ</span>
        <span className="panel-title-strong">
          <strong>Задачи проекта</strong>
          <Hint label="Задачи проекта">Список дел проекта. Агент читает его по запросу, когда нужен.</Hint>
        </span>
      </div>
      <div className="tasks-actions">
        <button className="icon-button" onClick={() => void load()} disabled={loading} title="Обновить задачи" aria-label="Обновить задачи">
          <RefreshCw size={14} className={loading ? "spin" : ""}/>
        </button>
        <button className="ghost-button tasks-copy" onClick={() => void copy()} disabled={!data?.exists} title="Скопировать TASKS.md">
          <Copy size={13}/><span>{copied ? "Скопировано" : "Копировать"}</span>
        </button>
      </div>
    </div>

    {error && <div className="tasks-error" role="alert">
      <span>{error}</span>
      <button className="ghost-button" onClick={() => void load()}>Обновить</button>
    </div>}
    {notice && <div className="tasks-notice" role="status">{notice}</div>}

    <div className="tasks-scroll">
      <div className="tasks-inner">
        {loading && !data
          ? <div className="tasks-loading"><NestLoader size={32} label="Загружаем задачи"/><span>Загружаем задачи…</span></div>
          : data
            ? <>
                {data.total > 0 && <div className={"tasks-summary" + (left === 0 ? " complete" : "")}>
                  <div className="tasks-summary-head"><span>Выполнено</span><strong>{data.done} из {data.total}</strong></div>
                  <div className="tasks-progress" role="progressbar" aria-valuemin={0} aria-valuemax={data.total} aria-valuenow={data.done} aria-label="Прогресс задач">
                    <span style={{ width: progress + "%" }}/>
                  </div>
                  <div className="tasks-summary-foot">
                    <span>{left === 0 ? "Всё готово" : "Осталось " + left}</span>
                    <code>{data.file}</code>
                  </div>
                </div>}

                {data.total === 0
                  ? <div className="tasks-empty">
                      <div className="tasks-empty-icon"><ListChecks size={25}/></div>
                      <strong>Задач пока нет</strong>
                      <span>Добавьте первый пункт внизу или нажмите «В задачи» под ответом агента.</span>
                    </div>
                  : groups.map(group => <div className="tasks-group" key={group.key || "root"}>
                      {showGroupHead && <div className="tasks-group-head">
                        <span>{group.title}</span>
                        <small>{group.tasks.filter(task => task.done).length} из {group.tasks.length}</small>
                      </div>}
                      <ul className="tasks-list">
                        {group.tasks.map(task => <li className={"task-row" + (task.done ? " done" : "")} key={task.line}>
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={task.done}
                            className={"task-check" + (task.done ? " checked" : "")}
                            disabled={busyLine !== null}
                            onClick={() => void toggle(task)}
                            title={task.done ? "Отметить незавершённой" : "Отметить выполненной"}
                            aria-label={(task.done ? "Отметить незавершённой: " : "Отметить выполненной: ") + task.title}
                          >
                            {busyLine === task.line
                              ? <Loader2 size={11} className="spin"/>
                              : task.done ? <Check size={11}/> : null}
                          </button>
                          <span className="task-text" style={{ paddingLeft: (task.depth ?? 0) * 14 }}>{task.title}</span>
                          <button className="icon-button task-delete" onClick={() => void remove(task)} disabled={busyLine !== null} title="Удалить задачу" aria-label={"Удалить задачу: " + task.title}>
                            <Trash2 size={12}/>
                          </button>
                        </li>)}
                      </ul>
                    </div>)}

                <p className="tasks-source">
                  Файл <code>TASKS.md</code> лежит в корне проекта и открывается во вкладке «Файлы». В контекст каждого запуска он не попадает — агент читает его по запросу.
                </p>
              </>
            : <div className="tasks-empty">
                <div className="tasks-empty-icon"><ListChecks size={25}/></div>
                <strong>Не удалось загрузить задачи</strong>
                <span>Проверьте соединение и попробуйте ещё раз.</span>
              </div>}
      </div>
    </div>

    {undo && <div className="tasks-undo" role="status">
      <span>Задача удалена</span>
      <button className="ghost-button" onClick={() => void undoRemove()}>Вернуть</button>
      <button className="icon-button" onClick={() => setUndo(null)} title="Скрыть" aria-label="Скрыть"><X size={12}/></button>
    </div>}

    <div className="tasks-compose">
      <input
        ref={inputRef}
        value={draft}
        onChange={event => { setDraft(event.target.value); setError(""); }}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void add(); } }}
        placeholder="Новая задача"
        aria-label="Новая задача"
        maxLength={500}
        spellCheck={false}
      />
      <button className="send-button tasks-add" onClick={() => void add()} disabled={!draft.trim() || adding || (loading && !data)} title={adding ? "Добавляем задачу" : "Добавить задачу"} aria-label={adding ? "Добавляем задачу" : "Добавить задачу"}>
        {adding ? <Loader2 size={15} className="spin"/> : <Plus size={16}/>}
      </button>
    </div>
  </section>;
}
