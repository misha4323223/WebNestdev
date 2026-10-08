import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Code2, LayoutDashboard, ShoppingBag, Sparkles, GitBranch, Globe, Layers3 } from "lucide-react";
import { createConversation, createProject, listProjects, type Project } from "../../lib/project-api";

const templates = [
  { name: "Landing Page", icon: Globe, prompt: "Создай современный лендинг для продукта" },
  { name: "SaaS", icon: Layers3, prompt: "Создай SaaS-приложение с авторизацией и личным кабинетом" },
  { name: "E-commerce", icon: ShoppingBag, prompt: "Создай интернет-магазин с каталогом и корзиной" },
  { name: "Dashboard", icon: LayoutDashboard, prompt: "Создай современный аналитический дашборд" },
];

export function HomeScreen({onOpenWorkspace}:{onOpenWorkspace:()=>void}){
  const [idea,setIdea]=useState("");
  const [projects,setProjects]=useState<Project[]>([]);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{void listProjects().then(result=>setProjects(result.projects.slice(0,6))).catch(()=>{});},[]);

  async function start(name:string){
    const project=await createProject(name);
    const conversation=await createConversation(project.id);
    localStorage.setItem("webnestdev.projectId",project.id);
    localStorage.setItem("webnestdev.projectName",project.name);
    localStorage.setItem("webnestdev.conversationId",conversation.id);
    onOpenWorkspace();
  }

  async function submit(event:FormEvent){
    event.preventDefault();
    const value=idea.trim();
    if(!value||busy)return;
    setBusy(true);
    try{await start(value.slice(0,80));}finally{setBusy(false);}
  }

  return <main className="home-screen">
    <section className="home-hero">
      <div className="home-kicker"><Sparkles size={13}/> AI development workspace</div>
      <h1>Создай что угодно.</h1>
      <p>Опиши идею — WebNestdev поможет превратить её в рабочий проект.</p>
      <form className="home-composer" onSubmit={submit}>
        <div className="home-composer-top"><span className="home-composer-icon"><Code2 size={16}/></span><textarea value={idea} onChange={e=>setIdea(e.target.value)} placeholder="Что будем создавать?" rows={2} /></div>
        <div className="home-composer-bottom"><span>Например: интернет-магазин одежды с каталогом и корзиной</span><button className="send-button home-submit" disabled={busy||!idea.trim()} aria-label="Создать проект"><ArrowRight size={15}/></button></div>
      </form>
    </section>

    <section className="home-section">
      <div className="home-section-head"><div><span className="eyebrow">QUICK START</span><h2>Начать с шаблона</h2></div></div>
      <div className="template-grid">{templates.map(template=>{const Icon=template.icon;return <button key={template.name} className="template-card" onClick={()=>void start(template.name)}><span className="template-icon"><Icon size={16}/></span><span><strong>{template.name}</strong><small>{template.prompt}</small></span><ArrowRight size={14}/></button>})}</div>
    </section>

    {projects.length>0&&<section className="home-section">
      <div className="home-section-head"><div><span className="eyebrow">YOUR WORK</span><h2>Последние проекты</h2></div><button className="home-link" onClick={()=>void start("Новый проект")}>Новый проект <ArrowRight size={13}/></button></div>
      <div className="recent-grid">{projects.map(project=><button key={project.id} className="recent-card" onClick={()=>{localStorage.setItem("webnestdev.projectId",project.id);localStorage.setItem("webnestdev.projectName",project.name);localStorage.removeItem("webnestdev.conversationId");onOpenWorkspace();}}><div className="recent-thumb"><Code2 size={18}/></div><strong>{project.name}</strong><span>{new Date(project.updatedAt).toLocaleDateString("ru-RU",{day:"numeric",month:"short"})}</span></button>)}</div>
    </section>}

    <footer className="home-footer"><span>WebNestdev</span><span>Build faster. Stay in control.</span><span><GitBranch size={12}/> GitHub</span></footer>
  </main>;
}
