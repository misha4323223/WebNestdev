import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, FolderGit2, Github, Menu, Plus, Send, Settings2, Sparkles, Terminal, X, RefreshCw, Square, ExternalLink } from "lucide-react";

type Message={role:"user"|"assistant";content:string};
type ServerEvent={type:string;delta?:string;error?:string};
type FileEntry={name:string;type:"file"|"directory"};
const API=import.meta.env.VITE_API_URL??"http://localhost:8787";

export function App(){
  const [messages,setMessages]=useState<Message[]>([{role:"assistant",content:"Привет. Я WebNestdev — веб-агент для создания и развития проектов. Опиши, что нужно сделать."}]);
  const [prompt,setPrompt]=useState("");
  const [sidebarOpen,setSidebarOpen]=useState(true);
  const [projectId,setProjectId]=useState("");
  const [projectName,setProjectName]=useState("Новый проект");
  const [running,setRunning]=useState(false);
  const [view,setView]=useState<"agent"|"files"|"terminal">("agent");
  const [files,setFiles]=useState<FileEntry[]>([]);
  const [terminalCommand,setTerminalCommand]=useState("");
  const [terminalOutput,setTerminalOutput]=useState("");
  const [preview,setPreview]=useState<{running:boolean;port?:number}>({running:false});
  const socket=useRef<WebSocket|null>(null);

  useEffect(()=>{
    let active=true;
    fetch(API+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Новый проект"})})
      .then(r=>r.json()).then(p=>{if(active){setProjectId(p.id);setProjectName(p.name)}}).catch(()=>{});
    return()=>{active=false;socket.current?.close()};
  },[]);

  async function loadFiles(){
    if(!projectId)return;
    try{const r=await fetch(API+"/api/projects/"+projectId+"/files");const d=await r.json();setFiles(d.files??[])}catch{}
  }

  async function runTerminal(){
    if(!projectId||!terminalCommand.trim())return;
    setTerminalOutput("Выполняю…");
    try{const r=await fetch(API+"/api/projects/"+projectId+"/terminal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command:terminalCommand})});const d=await r.json();setTerminalOutput([d.stdout,d.stderr].filter(Boolean).join("\n")||"Готово")}catch{setTerminalOutput("Ошибка подключения к серверу")}
  }

  async function startPreview(){
    if(!projectId)return;
    setPreview({running:false});
    try{const r=await fetch(API+"/api/projects/"+projectId+"/preview/start",{method:"POST"});const d=await r.json();if(r.ok)setPreview({running:true,port:d.port})}catch{}
  }

  async function stopPreview(){
    if(!projectId)return;
    await fetch(API+"/api/projects/"+projectId+"/preview/stop",{method:"POST"}).catch(()=>{});
    setPreview({running:false});
  }

  async function refreshPreview(){
    if(!projectId)return;
    try{const r=await fetch(API+"/api/projects/"+projectId+"/preview/status");const d=await r.json();setPreview(d)}catch{}
  }

  function sendPrompt(){
    const value=prompt.trim();
    if(!value||!projectId||running)return;
    const history=[...messages,{role:"user" as const,content:value}];
    setMessages([...history,{role:"assistant",content:""}]);
    setPrompt("");setRunning(true);
    const wsUrl=API.replace(/^http/,"ws")+"/ws";
    const ws=new WebSocket(wsUrl);socket.current=ws;
    ws.onopen=()=>ws.send(JSON.stringify({type:"agent.run",request:{projectId,messages:history}}));
    ws.onmessage=e=>{
      const data=JSON.parse(e.data) as ServerEvent;
      if(data.type==="message.delta")setMessages(cur=>{const next=[...cur];const last=next.at(-1);if(last?.role==="assistant")next[next.length-1]={...last,content:last.content+(data.delta??"")};return next});
      if(data.type==="run.failed"){setMessages(cur=>[...cur,{role:"assistant",content:"Ошибка: "+(data.error??"неизвестная ошибка")}]);setRunning(false);ws.close()}
      if(data.type==="run.completed"){setRunning(false);ws.close();loadFiles()}
    };
    ws.onerror=()=>{setRunning(false);setMessages(cur=>[...cur,{role:"assistant",content:"Не удалось подключиться к Agent Runtime."}])};
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><button className="icon-button mobile-only" onClick={()=>setSidebarOpen(v=>!v)}><Menu size={17}/></button><div className="brand-mark"><Sparkles size={15}/></div><span>WebNestdev</span><span className="version">WEB</span></div>
      <div className="topbar-project"><FolderGit2 size={15}/><span>{projectName}</span><ChevronDown size={14}/></div>
      <div className="topbar-actions"><button className="ghost-button"><Github size={15}/> GitHub</button><button className="icon-button"><Settings2 size={16}/></button></div>
    </header>
    <div className="workspace">
      <aside className={"sidebar "+(sidebarOpen?"open":"")}>
        <div className="sidebar-head"><button className="new-project"><Plus size={15}/> Новый проект</button><button className="icon-button mobile-only" onClick={()=>setSidebarOpen(false)}><X size={16}/></button></div>
        <div className="sidebar-section"><div className="section-label">Рабочая область</div>
          <button className={"nav-item "+(view==="agent"?"active":"")} onClick={()=>setView("agent")}><Bot size={15}/> Agent</button>
          <button className={"nav-item "+(view==="files"?"active":"")} onClick={()=>{setView("files");loadFiles()}}><FolderGit2 size={15}/> Файлы</button>
          <button className={"nav-item "+(view==="terminal"?"active":"")} onClick={()=>setView("terminal")}><Terminal size={15}/> Терминал</button>
        </div>
        <div className="sidebar-section"><div className="section-label">Проекты</div><div className="project-row"><span className="status-dot"/> {projectName}</div></div>
        <div className="sidebar-footer"><div className="sponsor-label">СПОНСОР СЕССИИ</div><div className="sponsor-card"><div className="sponsor-logo">YC</div><div><strong>Yandex Cloud</strong><span>Инфраструктура проекта</span></div></div></div>
      </aside>

      <main className="main">
        <section className="chat">
          {view==="files"&&<div className="panel"><div className="panel-title">Файлы проекта <button className="ghost-button" onClick={loadFiles}><RefreshCw size={14}/> Обновить</button></div><div className="file-list">{files.map(f=><div className="file-item" key={f.name}><FolderGit2 size={15}/><span>{f.name}</span><span>{f.type}</span></div>)}</div></div>}
          {view==="terminal"&&<div className="panel"><div className="panel-title">Терминал sandbox</div><textarea className="terminal-input" value={terminalCommand} onChange={e=>setTerminalCommand(e.target.value)} placeholder="npm --version"/><button className="send-button" onClick={runTerminal}>Запустить</button><pre className="terminal-output">{terminalOutput}</pre></div>}
          {view==="agent"&&<>
            <div className="chat-header"><div><div className="eyebrow">AGENT</div><h1>Что создаём?</h1></div><button className="model-select">WebNestdev Agent <ChevronDown size={14}/></button></div>
            <div className="messages">{messages.map((m,i)=><div className={"message-row "+m.role} key={i}><div className="message-avatar">{m.role==="assistant"?<Sparkles size={14}/>:"Вы"}</div><div className="message-content"><div className="message-role">{m.role==="assistant"?"WebNestdev":"Вы"}</div><div className="message-text">{m.content||(running?"Работаю…":"")}</div></div></div>)}</div>
            <div className="composer-wrap"><div className="composer"><textarea value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendPrompt()}}} placeholder="Опишите проект или задачу..." rows={3}/><div className="composer-footer"><span>Enter — отправить · Shift + Enter — новая строка</span><button className="send-button" disabled={running||!projectId} onClick={sendPrompt}><Send size={15}/></button></div></div></div>
          </>}
        </section>

        <aside className="preview">
          <div className="preview-head"><div><span className="eyebrow">PREVIEW</span><strong>Рабочая область</strong></div><div className="preview-actions">{preview.running?<button className="icon-button" onClick={stopPreview}><Square size={14}/></button>:<button className="icon-button" onClick={startPreview}><Terminal size={14}/></button>}<button className="icon-button" onClick={refreshPreview}><RefreshCw size={14}/></button>{preview.running&&<a className="icon-button" href={API.replace(":8787",":"+preview.port)} target="_blank" rel="noreferrer"><ExternalLink size={14}/></a>}</div></div>
          {preview.running&&preview.port?<iframe className="preview-frame" title="Live preview" src={API.replace(":8787",":"+preview.port)}/>:<div className="preview-empty"><div className="preview-icon"><FolderGit2 size={20}/></div><strong>Предпросмотр проекта</strong><span>Запусти preview после создания файлов проекта.</span><button className="ghost-button" onClick={startPreview}>Запустить preview</button></div>}
        </aside>
      </main>
    </div>
  </div>;
}
