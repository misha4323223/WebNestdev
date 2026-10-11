import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Code2, LayoutDashboard, Pencil, ShoppingBag, GitBranch, Globe, Layers3, Trash2 } from "lucide-react";
import { createConversation, createProject, deleteProject, listProjects, renameProject, type Project } from "../../lib/project-api";
import { logout } from "../../lib/auth-api";
import { HomeRail } from "./HomeRail";
import { WebNestLogo } from "../../components/WebNestLogo";
import { ProjectRenameForm } from "./ProjectRename";
import { PlanPickerModal } from "../billing/PlanPickerModal";
import { SubscriptionPage } from "../billing/SubscriptionPage";

const templates = [
  { name: "Лендинг", icon: Globe, prompt: "Создай современный лендинг для продукта" },
  { name: "SaaS-приложение", icon: Layers3, prompt: "Создай SaaS-приложение с авторизацией и личным кабинетом" },
  { name: "Интернет-магазин", icon: ShoppingBag, prompt: "Создай интернет-магазин с каталогом и корзиной" },
  { name: "Дашборд", icon: LayoutDashboard, prompt: "Создай современный аналитический дашборд" },
];

const activeProjectKey = "webnestdev.projectId";

export function HomeScreen({onOpenWorkspace}:{onOpenWorkspace:()=>void}){
  const [idea,setIdea]=useState("");
  const [projects,setProjects]=useState<Project[]>([]);
  const [busy,setBusy]=useState(false);
  const [deleting,setDeleting]=useState("");
  const [renaming,setRenaming]=useState("");
  const [error,setError]=useState("");
  const [page,setPage]=useState<"home"|"subscription">("home");
  const [plansOpen,setPlansOpen]=useState(false);

  const reload=useCallback(async()=>{try{setProjects((await listProjects()).projects)}catch{}},[]);
  useEffect(()=>{void reload()},[reload]);
  useEffect(()=>{window.scrollTo({top:0})},[page]);

  function open(project:Project){
    localStorage.setItem("webnestdev.projectId",project.id);
    localStorage.setItem("webnestdev.projectName",project.name);
    localStorage.removeItem("webnestdev.conversationId");
    onOpenWorkspace();
  }

  /** Returns true when the new name was stored, so inline forms know to close. */
  async function rename(project:Project,name:string):Promise<boolean>{
    setError("");
    try{
      const updated=await renameProject(project.id,name);
      setProjects(current=>current.map(item=>item.id===updated.id?updated:item));
      // Keep the open workspace label in sync when the renamed project is the active one.
      if(localStorage.getItem(activeProjectKey)===updated.id)localStorage.setItem("webnestdev.projectName",updated.name);
      setRenaming("");
      return true;
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось переименовать проект");
      return false;
    }
  }

  async function remove(project:Project){
    if(!window.confirm(`Удалить проект «${project.name}»? Его файлы, история и настройки провайдера будут удалены.`))return;
    setDeleting(project.id);
    setError("");
    try{
      await deleteProject(project.id);
      setProjects(current=>current.filter(item=>item.id!==project.id));
      if(localStorage.getItem(activeProjectKey)===project.id){
        localStorage.removeItem(activeProjectKey);
        localStorage.removeItem("webnestdev.conversationId");
        localStorage.removeItem("webnestdev.projectName");
      }
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось удалить проект");
    }finally{
      setDeleting("");
    }
  }

  /** Creates the project and opens it. Failures (for example a reached project
   *  limit) are reported instead of the button appearing to do nothing. */
  async function start(name:string){
    setBusy(true);
    setError("");
    try{
      const project=await createProject(name);
      const conversation=await createConversation(project.id);
      localStorage.setItem("webnestdev.projectId",project.id);
      localStorage.setItem("webnestdev.projectName",project.name);
      localStorage.setItem("webnestdev.conversationId",conversation.id);
      onOpenWorkspace();
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось создать проект");
    }finally{setBusy(false);}
  }

  async function submit(event:FormEvent){
    event.preventDefault();
    const value=idea.trim();
    if(!value||busy)return;
    await start(value.slice(0,80));
  }

  async function exit(){
    try{await logout()}finally{window.location.reload()}
  }

  const openPlans=()=>setPlansOpen(true);

  if(page==="subscription")return <>
    <SubscriptionPage onBack={()=>setPage("home")} onOpenPicker={openPlans}/>
    <PlanPickerModal open={plansOpen} onClose={()=>setPlansOpen(false)} onOpenDetails={()=>setPage("subscription")}/>
  </>;

  const activeProjectId=localStorage.getItem(activeProjectKey);

  return <>
    <main className="home-screen">
      <div className="home-layout">
        <div className="home-main">
          <section className="home-hero">
            <span className="home-hero-mark"><WebNestLogo size={132} tone="light"/></span>
            <p>Опиши идею — WebNestdev поможет превратить её в рабочий проект.</p>
            <form className="home-composer" onSubmit={submit}>
              <div className="home-composer-top"><span className="home-composer-icon"><Code2 size={16}/></span><textarea value={idea} onChange={e=>setIdea(e.target.value)} placeholder="Что будем создавать?" rows={2} /></div>
              <div className="home-composer-bottom"><span>Например: интернет-магазин одежды с каталогом и корзиной</span><button className="send-button home-submit" disabled={busy||!idea.trim()} aria-label="Создать проект"><ArrowRight size={15}/></button></div>
            </form>
          </section>

          {error&&<div className="home-error">{error}</div>}

          <section className="home-section">
            <div className="home-section-head"><div><span className="eyebrow">БЫСТРЫЙ СТАРТ</span><h2>Начать с шаблона</h2></div></div>
            <div className="template-grid">{templates.map(template=>{const Icon=template.icon;return <button key={template.name} className="template-card" onClick={()=>void start(template.name)}><span className="template-icon"><Icon size={16}/></span><span><strong>{template.name}</strong><small>{template.prompt}</small></span><ArrowRight size={14}/></button>})}</div>
          </section>

          {projects.length>0&&<section className="home-section">
            <div className="home-section-head"><div><span className="eyebrow">ВАШИ ПРОЕКТЫ</span><h2>Последние проекты</h2></div><button className="home-link" onClick={()=>void start("Новый проект")}>Новый проект <ArrowRight size={13}/></button></div>
            <div className="recent-grid">{projects.slice(0,6).map(project=><div key={project.id} className="recent-card">
              {renaming===project.id
                ? <ProjectRenameForm initial={project.name} onSubmit={name=>void rename(project,name)} onCancel={()=>setRenaming("")}/>
                : <button className="recent-open" onClick={()=>open(project)} title={"Открыть проект «"+project.name+"»"}>
                    <span className="recent-thumb"><Code2 size={14}/></span>
                    <strong>{project.name}</strong>
                  </button>}
              {renaming!==project.id&&<div className="recent-tools">
                <button onClick={()=>setRenaming(project.id)} title="Переименовать" aria-label={"Переименовать проект "+project.name}><Pencil size={13}/></button>
                <button className="danger" onClick={()=>void remove(project)} disabled={deleting===project.id} title="Удалить проект" aria-label={"Удалить проект "+project.name}><Trash2 size={13}/></button>
              </div>}
            </div>)}</div>
          </section>}

          <footer className="home-footer"><span>WebNestdev</span><span>Создавайте быстрее. Оставайтесь в контроле.</span><span><GitBranch size={12}/> GitHub</span></footer>
        </div>

        <HomeRail
          projects={projects}
          activeProjectId={activeProjectId}
          onOpen={open}
          onRename={rename}
          onDelete={project=>void remove(project)}
          onNewProject={()=>void start("Новый проект")}
          onOpenPlans={openPlans}
          onOpenSubscriptions={()=>setPage("subscription")}
          onExit={()=>void exit()}
        />
      </div>
    </main>
    <PlanPickerModal open={plansOpen} onClose={()=>setPlansOpen(false)} onOpenDetails={()=>{setPlansOpen(false);setPage("subscription")}} onChanged={()=>void reload()}/>
  </>;
}
