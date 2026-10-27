import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Code2, CreditCard, FolderGit2, Home, LayoutDashboard, LogOut, Pencil, Plug, ShoppingBag, Globe, Layers3, Trash2, UserRound } from "lucide-react";
import { deleteProject, listProjects, renameProject, type Project } from "../../lib/project-api";
import { logout } from "../../lib/auth-api";
import { HomeRail, type RailSection } from "./HomeRail";
import { WebNestLogo } from "../../components/WebNestLogo";
import { NestLoader } from "../../components/NestLoader";
import { ProjectRenameForm } from "./ProjectRename";
import { PlanPickerModal } from "../billing/PlanPickerModal";
import { SubscriptionPage } from "../billing/SubscriptionPage";
import { conversationMemoryKey } from "../workspace/useWorkspace";
import { LEGAL_FOOTER_LINKS, SELLER, legalDoc, legalPath } from "../../lib/legal";
import { ideaKickoff } from "../../lib/agent-kickoff";
import { startProjectWithAgent } from "../../lib/start-project";

const templates = [
  { name: "Лендинг", icon: Globe, prompt: "Создай современный лендинг для продукта" },
  { name: "SaaS-приложение", icon: Layers3, prompt: "Создай SaaS-приложение с авторизацией и личным кабинетом" },
  { name: "Интернет-магазин", icon: ShoppingBag, prompt: "Создай интернет-магазин с каталогом и корзиной" },
  { name: "Дашборд", icon: LayoutDashboard, prompt: "Создай современный аналитический дашборд" },
];

/**
 * Шаблон не сразу пишет код: агент открывается планировщиком, уточняет детали и показывает план.
 * Кнопка подтверждения в панели затем переводит его в режим разработчика.
 */
function templateKickoff(template:typeof templates[number]){
  return `Быстрый старт по шаблону «${template.name}».\n\nЗадача: ${template.prompt}.\n\nСначала работай в режиме планировщика: не меняй файлы. Изучи, что уже есть в проекте (для нового проекта это пусто), задай через question.ask не больше двух действительно важных уточняющих вопросов (например, для кого продукт, какие разделы и данные нужны, какой стиль), если ответов нет в проекте. Затем собери полный пошаговый план через plan.update: структура, страницы и компоненты, данные и состояния, визуальный стиль, проверка результата. В конце кратко перечисли допущения и то, что пользователю нужно подтвердить перед началом разработки.`;
}

const activeProjectKey = "webnestdev.projectId";
/** Черновик идеи на главной: страница открывается с нуля, а написанное должно остаться. */
const ideaDraftKey = "webnestdev.ideaDraft";

/** На телефоне та же колонка, что на ПК, но вкладками: главная страница плюс её разделы. */
type HomeTab = "home" | RailSection;

const homeTabs: Array<{ id: HomeTab; label: string; icon: typeof Home }> = [
  { id: "home", label: "Главная", icon: Home },
  { id: "integrations", label: "Интеграции", icon: Plug },
  { id: "projects", label: "Проекты", icon: FolderGit2 },
  { id: "account", label: "Аккаунт", icon: UserRound },
  { id: "billing", label: "Оплата", icon: CreditCard },
];

export function HomeScreen({onOpenWorkspace,activeRun}:{onOpenWorkspace:(projectId:string)=>void;activeRun:{projectId:string;projectName:string}|null}){
  const [idea,setIdea]=useState(()=>{try{return localStorage.getItem(ideaDraftKey)??""}catch{return ""}});
  const [projects,setProjects]=useState<Project[]>([]);
  const [busy,setBusy]=useState(false);
  const [deleting,setDeleting]=useState("");
  const [renaming,setRenaming]=useState("");
  const [error,setError]=useState("");
  const [page,setPage]=useState<"home"|"subscription">("home");
  const [plansOpen,setPlansOpen]=useState(false);
  // Вкладка телефона и раздел колонки: выбор раздела на телефоне показывает его сразу,
  // а на ПК та же колонка остаётся рядом с главной страницей.
  const [tab,setTab]=useState<HomeTab>("home");
  // Все категории колонки свёрнуты при открытии: человек сначала видит оглавление, а не его раздел.
  const [section,setSection]=useState<RailSection|null>(null);
  // Возврат со страницы оплаты: платёжная система переводит браузер сюда с отметкой в адресе.
  const [paymentReturn,setPaymentReturn]=useState<"success"|"fail"|null>(null);

  const tabsRef = useRef<HTMLDivElement | null>(null);

  function pick(next:HomeTab){
    setTab(next);
    if(next!=="home")setSection(next);
  }

  /** Категория колонки — переключатель: повторное нажатие сворачивает её обратно. */
  function toggleSection(next:RailSection){
    const closing=section===next;
    setSection(closing?null:next);
    // На телефоне колонки нет, но вкладка должна оставаться согласованной с разделом.
    setTab(closing?"home":next);
  }

  // Строка вкладок на телефоне прокручивается: выбранный раздел подъезжает в видимую часть.
  useEffect(() => {
    tabsRef.current?.querySelector(".home-tab.active")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);

  // Идея сохраняется на каждое нажатие, поэтому перезагрузка страницы не теряет написанное.
  useEffect(()=>{
    try{
      if(idea)localStorage.setItem(ideaDraftKey,idea);
      else localStorage.removeItem(ideaDraftKey);
    }catch{}
  },[idea]);

  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const status=params.get("payment");
    if(status!=="success"&&status!=="fail")return;
    setPaymentReturn(status);
    // Успешная оплата открывает раздел подписки: там видно новый срок и платёж.
    if(status==="success")pick("billing");
    params.delete("payment");params.delete("inv");
    const query=params.toString();
    window.history.replaceState({},"",window.location.pathname+(query?"?"+query:""));
  },[]);

  const reload=useCallback(async()=>{try{setProjects((await listProjects()).projects)}catch{}},[]);
  useEffect(()=>{void reload()},[reload]);
  useEffect(()=>{window.scrollTo({top:0})},[page]);

  function open(project:Project){
    localStorage.setItem("webnestdev.projectId",project.id);
    localStorage.setItem("webnestdev.projectName",project.name);
    // Возврат в проект открывает тот чат, в котором человек был, а не создаёт новый.
    // Если проект ещё ни разу не открывался в этом браузере, идентификатор не подставляется —
    // рабочая область выберет последний чат с перепиской сама (useWorkspace).
    const remembered=localStorage.getItem(conversationMemoryKey(project.id));
    if(remembered)localStorage.setItem("webnestdev.conversationId",remembered);
    else localStorage.removeItem("webnestdev.conversationId");
    onOpenWorkspace(project.id);
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
   *  limit) are reported instead of the button appearing to do nothing. Возвращает признак
   *  успеха: по нему отправившая идею форма убирает свой черновик. Если передан `plannerPrompt`,
   *  рабочая область сразу запустит агента в режиме планирования. */
  async function start(name:string,options:{plannerPrompt?:string;title?:string}={}):Promise<boolean>{
    setBusy(true);
    setError("");
    try{
      const project=await startProjectWithAgent({name,...options});
      onOpenWorkspace(project.id);
      return true;
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось создать проект");
      return false;
    }finally{setBusy(false);}
  }

  async function submit(event:FormEvent){
    event.preventDefault();
    const value=idea.trim();
    if(!value||busy)return;
    // Идея уходит агенту целиком: рабочая область открывается с уже начатым планировщиком,
    // который задаёт уточняющие вопросы и показывает план, поэтому повторять идею в чате не нужно.
    // Черновик убирается только после того, как проект создан: иначе ошибка стирала бы идею.
    if(await start(value.slice(0,80),{plannerPrompt:ideaKickoff(value),title:"Новая идея"}))setIdea("");
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
      <div className="home-layout" data-tab={tab}>
        {/* Только на телефоне: там разделы переключаются вкладками, как колонка рядом с ПК. */}
        <nav className="home-tabs" aria-label="Разделы главной">
          <div className="home-tabs-track" ref={tabsRef}>
            {homeTabs.map(item => { const Icon = item.icon; return <button key={item.id} className={"home-tab" + (tab === item.id ? " active" : "")} onClick={() => pick(item.id)} aria-current={tab === item.id ? true : undefined}>
              <Icon size={14}/> <span>{item.label}</span>
            </button>; })}
          </div>
          <button className="home-tab-exit" onClick={() => void exit()} title="Выйти" aria-label="Выйти из аккаунта"><LogOut size={14}/></button>
        </nav>

        <div className={"home-main" + (activeRun ? " has-run" : "")}>
          {/* Рабочая область живёт дальше на главной, поэтому запуск виден и здесь. */}
          {activeRun && <div className="home-run" role="status">
            <NestLoader size={24} label="Агент работает"/>
            <div><strong>Агент продолжает работу над проектом «{activeRun.projectName}»</strong><span>Запуск не остановится, пока вы на главной — вернитесь, когда захотите.</span></div>
            <button className="ghost-button home-run-open" onClick={() => onOpenWorkspace(activeRun.projectId)}>Вернуться в проект</button>
          </div>}

          <section className="home-hero">
            <span className="home-hero-mark"><WebNestLogo size={168} tone="light"/></span>
            <p>Опиши идею — NestDev поможет превратить её в рабочий проект.</p>
            <form className="home-composer" onSubmit={submit}>
              <div className="home-composer-top"><span className="home-composer-icon"><Code2 size={16}/></span><textarea value={idea} onChange={e=>setIdea(e.target.value)} placeholder="Что будем создавать?" rows={2} /></div>
              <div className="home-composer-bottom"><span>{busy?"Создаём проект и запускаем планировщика…":"Опиши идею — агент уточнит детали."}</span><button className="send-button home-submit" disabled={busy||!idea.trim()} aria-label="Создать проект и запустить агента"><ArrowRight size={15}/></button></div>
            </form>
          </section>

          {paymentReturn&&<div className={"home-payment "+paymentReturn} role="status">
            <div>
              <strong>{paymentReturn==="success"?"Оплата принята":"Оплата не прошла"}</strong>
              <span>{paymentReturn==="success"
                ?"Тариф включится автоматически. Если он ещё прежний, обновите через минуту."
                :"Деньги не списаны. Можно вернуться к тарифам и попробовать снова."}</span>
            </div>
            <div className="home-payment-actions">
              <button className="ghost-button" onClick={()=>setPaymentReturn(null)}>Закрыть</button>
              {paymentReturn==="success"&&<button className="send-button" onClick={()=>window.location.reload()}>Обновить</button>}
            </div>
          </div>}

          {error&&<div className="home-error">{error}</div>}

          <section className="home-section">
            <div className="home-section-head"><div><span className="eyebrow">БЫСТРЫЙ СТАРТ</span><h2>Начать с шаблона</h2></div></div>
            <div className="template-grid">{templates.map(template=>{const Icon=template.icon;return <button key={template.name} className="template-card" onClick={()=>void start(template.name,{plannerPrompt:templateKickoff(template),title:"Быстрый старт: "+template.name})} title="Агент начнёт с плана и уточняющих вопросов"><span className="template-icon"><Icon size={16}/></span><span><strong>{template.name}</strong><small>{template.prompt}</small></span><ArrowRight size={14}/></button>})}</div>
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

          {/* Подвал — единственное место на главной, где документы видны без открытия меню.
              Ссылки открываются в новой вкладке: черновик идеи и очередь запуска не теряются. */}
          <footer className="home-footer">
            <span>© {new Date().getFullYear()} NestDev</span>
            <nav className="home-footer-legal" aria-label="Юридические документы">
              {LEGAL_FOOTER_LINKS.map(id => <a key={id} href={legalPath(id)} target="_blank" rel="noopener noreferrer">{legalDoc(id).short}</a>)}
            </nav>
            <span className="home-footer-note">Создавайте быстрее. Оставайтесь в контроле.</span>
            {/* Реквизиты продавца — в подвале, а не только на странице контактов: этого требует
                модерация платёжного сервиса, и это же правило Закона о защите прав потребителей. */}
            <div className="home-footer-requisites">
              <span>{SELLER.status} {SELLER.fullName} · ИНН {SELLER.inn}{SELLER.city ? " · " + SELLER.city : ""}</span>
              <a href={"mailto:" + SELLER.email}>{SELLER.email}</a>
              <a href={"tel:" + SELLER.phoneHref}>{SELLER.phone}</a>
              <a href={legalPath("contacts")}>Реквизиты и контакты</a>
            </div>
          </footer>
        </div>

        <HomeRail
          projects={projects}
          activeProjectId={activeProjectId}
          section={section}
          onSection={toggleSection}
          onOpen={open}
          onRename={rename}
          onDelete={project=>void remove(project)}
          onOpenPlans={openPlans}
          onOpenSubscriptions={()=>setPage("subscription")}
          onExit={()=>void exit()}
        />
      </div>
    </main>
    <PlanPickerModal open={plansOpen} onClose={()=>setPlansOpen(false)} onOpenDetails={()=>{setPlansOpen(false);setPage("subscription")}} onChanged={()=>void reload()}/>
  </>;
}
