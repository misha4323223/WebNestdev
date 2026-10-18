import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, Loader2, Lock, Plus, Trash2, Upload } from "lucide-react";
import { deleteProjectSecret, importProjectSecrets, listProjectSecrets, saveProjectSecrets, type ProjectSecret } from "../../lib/project-api";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Секреты проекта — это переменные окружения приложения, а не ключи платформы. Пользователь
 * сам задаёт пары KEY=value, сервер хранит их зашифрованными вне рабочей области и монтирует
 * в предпросмотр как обычный `.env.local`. Значение никогда не возвращается обратно: в списке
 * видно имя, файл и форму, а заменить или удалить секрет можно без чтения.
 */
export function ProjectSecretsPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [variables, setVariables] = useState<ProjectSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<{ name: string; file: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [envText, setEnvText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setVariables((await listProjectSecrets(projectId)).variables);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [projectId]);

  function feedback(message: string) {
    setStatus(message);
    setError("");
  }

  async function addSecret() {
    const variable = name.trim();
    if (!NAME.test(variable)) {
      setError("Имя переменной — латинские буквы, цифры и подчёркивание, например STRIPE_SECRET_KEY");
      return;
    }
    if (!value.trim()) {
      setError("Введите значение секрета");
      return;
    }
    setBusy("add"); setError(""); setStatus("");
    try {
      const data = await saveProjectSecrets(projectId, { [variable]: value });
      setVariables(data.variables);
      setName(""); setValue("");
      feedback("Секрет " + variable + " сохранён в " + data.file);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function startEdit(variable: ProjectSecret) {
    setEditing({ name: variable.name, file: variable.file });
    setEditValue("");
    setError(""); setStatus("");
  }

  function cancelEdit() {
    setEditing(null);
    setEditValue("");
  }

  async function saveEdit() {
    const target = editing;
    if (!target) return;
    if (!editValue.trim()) {
      setError("Введите новое значение");
      return;
    }
    setBusy("edit:" + target.file + ":" + target.name); setError(""); setStatus("");
    try {
      const data = await saveProjectSecrets(projectId, { [target.name]: editValue }, target.file);
      setVariables(data.variables);
      setEditing(null); setEditValue("");
      feedback("Значение " + target.name + " заменено");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(variable: ProjectSecret) {
    const suffix = variable.file === ".env.local" ? "" : " из " + variable.file;
    if (!window.confirm("Удалить " + variable.name + suffix + "? Приложение больше не увидит process.env." + variable.name + ".")) return;
    setBusy("delete:" + variable.file + ":" + variable.name); setError(""); setStatus("");
    try {
      const data = await deleteProjectSecret(projectId, variable.name, variable.file);
      setVariables(data.variables);
      if (editing?.file === variable.file && editing.name === variable.name) cancelEdit();
      feedback(data.deleted ? "Секрет " + variable.name + " удалён" : "Переменная " + variable.name + " уже удалена");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function applyImport(text: string) {
    if (!text.trim()) {
      setError("Вставьте хотя бы одну строку вида KEY=value");
      return;
    }
    setBusy("import"); setError(""); setStatus("");
    try {
      const data = await importProjectSecrets(projectId, text);
      setVariables(data.variables);
      setEnvText("");
      setImportOpen(false);
      feedback("Файл применён · переменных в проекте: " + data.variables.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function readFile(file: File) {
    if (file.size > 500_000) {
      setError("Файл больше 500 КБ — это не .env с секретами проекта");
      return;
    }
    await applyImport(await file.text());
  }

  return <section className="settings-panel project-secrets">
    <div className="panel-title"><div><span className="eyebrow">СЕКРЕТЫ ПРОЕКТА</span><strong>Переменные окружения</strong></div>
      <button className="ghost-button" onClick={() => void load()} disabled={loading || busy !== null}>Обновить</button>
    </div>
    <div className="settings-body">
      <div className="project-secret-note">
        <Lock size={14}/>
        <span>Проект «{projectName}». Значения хранятся зашифрованными вне файлов проекта и монтируются в предпросмотр как <code>.env.local</code>; приложение читает их как <code>process.env.NAME</code>. Сервер не отдаёт значения в браузер: их можно заменить или удалить, но не прочитать.</span>
      </div>

      <div className="project-secret-add">
        <label>Имя переменной<input value={name} onChange={event => setName(event.target.value)} placeholder="STRIPE_SECRET_KEY" autoComplete="off" spellCheck={false} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void addSecret(); } }}/></label>
        <label>Значение<input type="password" value={value} onChange={event => setValue(event.target.value)} placeholder="sk_live_…" autoComplete="new-password" spellCheck={false} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void addSecret(); } }}/></label>
        <button className="send-button" onClick={() => void addSecret()} disabled={busy !== null || !name.trim() || !value.trim()}>
          {busy === "add" ? <><Loader2 size={13} className="spin"/> Сохраняю…</> : <><Plus size={13}/> Добавить</>}
        </button>
      </div>

      {loading ? <div className="project-secret-state">Загружаем секреты проекта…</div> : variables.length === 0 ? <div className="project-secret-empty">
        <KeyRound size={24}/>
        <strong>Секретов пока нет</strong>
        <span>Добавьте первый ключ — например, STRIPE_SECRET_KEY. Агент и предпросмотр прочитают его при следующем запуске.</span>
      </div> : <ul className="project-secret-list">
        {variables.map(item => {
          const isEditing = editing?.name === item.name && editing.file === item.file;
          const row = item.file + ":" + item.name;
          return <li className={"project-secret-row" + (isEditing ? " editing" : "")} key={row}>
            <div className="project-secret-identity">
              <code>{item.name}</code>
              <span className="project-secret-preview">{item.preview}</span>
              {item.file !== ".env.local" && <span className="project-secret-file">{item.file}</span>}
            </div>
            {isEditing ? <div className="project-secret-edit">
              <input type="password" value={editValue} onChange={event => setEditValue(event.target.value)} placeholder="Новое значение" autoComplete="new-password" spellCheck={false} autoFocus onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveEdit(); } if (event.key === "Escape") cancelEdit(); }}/>
              <button className="ghost-button" onClick={() => void saveEdit()} disabled={busy !== null || !editValue.trim()}>{busy === "edit:" + item.file + ":" + item.name ? <Loader2 size={13} className="spin"/> : <Check size={13}/>} Сохранить</button>
              <button className="ghost-button" onClick={cancelEdit} disabled={busy !== null}>Отмена</button>
            </div> : <div className="project-secret-actions">
              <button className="ghost-button" onClick={() => startEdit(item)} disabled={busy !== null}>Заменить</button>
              <button className="icon-button danger" title={"Удалить " + item.name} aria-label={"Удалить " + item.name} onClick={() => void remove(item)} disabled={busy !== null}>{busy === "delete:" + item.file + ":" + item.name ? <Loader2 size={13} className="spin"/> : <Trash2 size={13}/>}</button>
            </div>}
          </li>;
        })}
      </ul>}

      <div className={"project-secret-drop" + (dragging ? " dragging" : "")}
        onDragOver={event => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files?.[0]; if (file) void readFile(file); }}
      >
        <div><Upload size={15}/><strong>Импорт .env</strong><span>Перетащите файл или вставьте строки KEY=value — переменные с теми же именами заменятся</span></div>
        <div className="project-secret-import-actions">
          <button className="ghost-button" onClick={() => fileInput.current?.click()} disabled={busy !== null}>Выбрать файл</button>
          <button className="ghost-button" onClick={() => setImportOpen(value => !value)} disabled={busy !== null}>{importOpen ? "Скрыть текст" : "Вставить текст"}</button>
        </div>
        <input ref={fileInput} type="file" accept=".env,text/plain" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void readFile(file); }}/>
      </div>
      {importOpen && <div className="project-secret-import-body">
        <textarea className="platform-env-text" rows={5} value={envText} onChange={event => setEnvText(event.target.value)} placeholder={"STRIPE_SECRET_KEY=sk_live_…\nDATABASE_URL=postgres://…"} spellCheck={false}/>
        <div className="model-row"><button className="ghost-button" onClick={() => void applyImport(envText)} disabled={busy !== null || !envText.trim()}>{busy === "import" ? "Импортирую…" : "Импортировать"}</button></div>
      </div>}

      {status && <div className="settings-status project-secret-result"><Check size={13}/><span>{status}</span></div>}
      {error && <div className="settings-error">{error}</div>}
    </div>
  </section>;
}
