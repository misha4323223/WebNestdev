import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, FolderGit2, Github, Menu, Plus, Send, Settings2, Sparkles, Terminal, X } from "lucide-react";

type Message = { role: "user" | "assistant"; content: string };
type ServerEvent = { type: string; delta?: string; error?: string };

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
const starterMessages: Message[] = [{ role: "assistant", content: "Привет. Я WebNestdev — веб-агент для создания и развития проектов. Опиши, что нужно сделать." }];

export function App() {
  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [prompt, setPrompt] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("Новый проект");
  const [model] = useState("WebNestdev Agent");
  const [running, setRunning] = useState(false);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let active = true;
    fetch(API + "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Новый проект" }) })
      .then((r) => r.json()).then((project: { id: string; name: string }) => { if (active) { setProjectId(project.id); setProjectName(project.name); } })
      .catch(() => undefined);
    return () => { active = false; socket.current?.close(); };
  }, []);

  function sendPrompt() {
    const value = prompt.trim();
    if (!value || !projectId || running) return;
    setMessages((current) => [...current, { role: "user", content: value }, { role: "assistant", content: "" }]);
    setPrompt("");
    setRunning(true);
    const wsUrl = API.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    socket.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "agent.run", request: { projectId, messages: [...messages, { role: "user", content: value }] } }));
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data) as ServerEvent;
      if (data.type === "message.delta") setMessages((current) => { const next = [...current]; const last = next.at(-1); if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + (data.delta ?? "") }; return next; });
      if (data.type === "run.failed") setMessages((current) => [...current, { role: "assistant", content: "Ошибка: " + (data.error ?? "неизвестная ошибка") }]);
      if (data.type === "run.completed" || data.type === "run.failed") { setRunning(false); ws.close(); }
    };
    ws.onerror = () => { setRunning(false); setMessages((current) => [...current, { role: "assistant", content: "Не удалось подключиться к Agent Runtime. Запустите сервер WebNestdev." }]); };
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><button className="icon-button mobile-only" onClick={() => setSidebarOpen((v) => !v)} aria-label="Меню"><Menu size={17} /></button><div className="brand-mark"><Sparkles size={15} /></div><span>WebNestdev</span><span className="version">WEB</span></div>
        <div className="topbar-project"><FolderGit2 size={15} /><span>{projectName}</span><ChevronDown size={14} /></div>
        <div className="topbar-actions"><button className="ghost-button"><Github size={15} /> GitHub</button><button className="icon-button" aria-label="Настройки"><Settings2 size={16} /></button></div>
      </header>
      <div className="workspace">
        <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
          <div className="sidebar-head"><button className="new-project"><Plus size={15} /> Новый проект</button><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Закрыть"><X size={16} /></button></div>
          <div className="sidebar-section"><div className="section-label">Рабочая область</div><button className="nav-item active"><Bot size={15} /> Agent</button><button className="nav-item"><FolderGit2 size={15} /> Файлы</button><button className="nav-item"><Terminal size={15} /> Терминал</button></div>
          <div className="sidebar-section"><div className="section-label">Проекты</div><div className="project-row"><span className="status-dot" /> {projectName}</div></div>
          <div className="sidebar-footer"><div className="sponsor-label">СПОНСОР СЕССИИ</div><div className="sponsor-card"><div className="sponsor-logo">YC</div><div><strong>Yandex Cloud</strong><span>Инфраструктура проекта</span></div></div></div>
        </aside>
        <main className="main">
          <section className="chat">
            <div className="chat-header"><div><div className="eyebrow">AGENT</div><h1>Что создаём?</h1></div><button className="model-select">{model}<ChevronDown size={14} /></button></div>
            <div className="messages">{messages.map((message, index) => <div className={`message-row ${message.role}`} key={index}><div className="message-avatar">{message.role === "assistant" ? <Sparkles size={14} /> : "Вы"}</div><div className="message-content"><div className="message-role">{message.role === "assistant" ? "WebNestdev" : "Вы"}</div><div className="message-text">{message.content || (running ? "Работаю…" : "")}</div></div></div>)}</div>
            <div className="composer-wrap"><div className="composer"><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); } }} placeholder="Опишите проект или задачу..." rows={3} /><div className="composer-footer"><span>Enter — отправить · Shift + Enter — новая строка</span><button className="send-button" disabled={running || !projectId} onClick={sendPrompt} aria-label="Отправить"><Send size={15} /></button></div></div></div>
          </section>
          <aside className="preview"><div className="preview-head"><div><span className="eyebrow">PREVIEW</span><strong>Рабочая область</strong></div><span className="preview-status"><span className="status-dot" /> {running ? "Agent работает" : "Ожидание"}</span></div><div className="preview-empty"><div className="preview-icon"><FolderGit2 size={20} /></div><strong>Предпросмотр проекта</strong><span>Здесь появится live preview после подключения sandbox.</span></div></aside>
        </main>
      </div>
    </div>
  );
}
