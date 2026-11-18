import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, AppWindow, Bot, Box, Boxes, Building2, ChevronDown, Code2, CreditCard, Database, FolderGit2, Gamepad2, Globe, Home, LayoutDashboard, Layers3, Lock, LogOut, MessageCircle, Newspaper, Pencil, Plug, Rocket, ShoppingBag, Smartphone, Sparkles, Store, Trash2, UserRound, Workflow } from "lucide-react";
import { deleteProject, listProjects, renameProject, type Project } from "../../lib/project-api";
import type { PlanId } from "../../lib/billing-api";
import { getEntitlements, type AccountEntitlements } from "../../lib/entitlements-api";
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
import { NotificationsBell } from "../notifications/NotificationsBell";

type TemplateTier = "free" | "pro" | "team";
type Template = { name: string; note: string; prompt: string; icon: typeof Globe; tier?: Exclude<TemplateTier, "free">; why?: string };
type TemplateGroup = { id: string; name: string; range: string; blurb: string; icon: typeof Globe; templates: Template[] };

/**
 * Категории шаблонов отвечают на два разных вопроса: «что здесь вообще можно собрать» —
 * заголовок и диапазон, «с чего начать прямо сейчас» — карточки внутри. Плоская сетка этого
 * не показывала: лендинг и маркетплейс стояли рядом как равные, хотя это разные масштабы.
 */
const templateGroups: TemplateGroup[] = [
  {
    id: "sites", name: "Сайты", range: "Лендинг · магазин · маркетплейс", icon: Globe,
    blurb: "От одной страницы с оффером до маркетплейса с продавцами, каталогом, корзиной и оплатой.",
    templates: [
      { name: "Лендинг", note: "Одна страница: оффер, преимущества, заявка", icon: Rocket, prompt: "Создай современный лендинг для продукта: первый экран с оффером, преимущества, отзывы, блок с ценами и форма заявки" },
      { name: "Корпоративный сайт", note: "Несколько страниц, услуги, команда и контакты", icon: Building2, prompt: "Создай корпоративный сайт компании: главная, услуги, о компании, кейсы и контакты, с общим меню и адаптивом" },
      { name: "Интернет-магазин", note: "Каталог, карточки, корзина и оформление заказа", icon: ShoppingBag, tier: "pro", why: "нужны функции и база для заказов", prompt: "Создай интернет-магазин: каталог с фильтрами, карточка товара, корзина и оформление заказа" },
      { name: "Маркетплейс", note: "Продавцы, категории, заказы и кабинеты", icon: Store, tier: "pro", why: "нужны роли, заказы и база", prompt: "Создай маркетплейс: продавцы, категории, карточки товаров, заказы и кабинеты покупателя и продавца" },
      { name: "Блог или медиа", note: "Статьи, рубрики, поиск и подписка", icon: Newspaper, prompt: "Создай сайт-блог или медиа: лента статей, рубрики, страница статьи, поиск и подписка на обновления" },
    ],
  },
  {
    id: "apps", name: "Приложения", range: "Android · iOS · PWA · Telegram", icon: Smartphone,
    blurb: "Экраны под телефон, установка из браузера, Mini App внутри Telegram и SaaS-кабинет с подпиской.",
    templates: [
      { name: "Мобильное приложение", note: "Экраны для Android и iOS с навигацией", icon: Smartphone, prompt: "Создай мобильное приложение для Android и iOS: 4–6 экранов с навигацией, списками и сохранением данных" },
      { name: "PWA", note: "Устанавливается из браузера, работает офлайн", icon: AppWindow, prompt: "Создай PWA: устанавливается из браузера, работает офлайн, показывает уведомления и хранит данные на устройстве" },
      { name: "Telegram Mini App", note: "Интерфейс внутри Telegram с профилем", icon: MessageCircle, prompt: "Создай Telegram Mini App: интерфейс внутри Telegram, профиль пользователя, основные действия и адаптация под телефон" },
      { name: "SaaS-сервис", note: "Аккаунты, тарифы и личный кабинет", icon: Layers3, tier: "pro", why: "нужны аккаунты, база и функции", prompt: "Создай SaaS-сервис: регистрация, тарифы, личный кабинет и основная рабочая функция" },
    ],
  },
  {
    id: "games", name: "Игры и 3D", range: "2D · 3D · интерактив", icon: Gamepad2,
    blurb: "Браузерные игры и объёмные сцены: управление, уровни, счёт и эффекты — без установки.",
    templates: [
      { name: "3D-игра", note: "Сцена, управление, цели и счёт", icon: Box, prompt: "Создай браузерную 3D-игру: управление, цели, счёт и перезапуск раунда" },
      { name: "2D-игра", note: "Аркада с уровнями и рекордами", icon: Gamepad2, prompt: "Создай браузерную 2D-игру: уровни, управление, счёт и таблица рекордов" },
      { name: "3D-витрина", note: "Товар или объект, который можно вращать", icon: Boxes, prompt: "Создай интерактивную 3D-витрину: объект или товар, вращение, ракурсы и подписи" },
    ],
  },
  {
    id: "data", name: "Данные и автоматизация", range: "Дашборд · CRM · боты · AI", icon: Workflow,
    blurb: "Графики, таблицы, роли, боты и ассистенты — внутренние инструменты, которые сразу работают.",
    templates: [
      { name: "Дашборд", note: "Метрики, графики и фильтры", icon: LayoutDashboard, prompt: "Создай аналитический дашборд: метрики, графики, фильтры и таблица последних событий" },
      { name: "CRM и админка", note: "Клиенты, таблицы и роли доступа", icon: Database, tier: "pro", why: "нужны база, функции и роли", prompt: "Создай CRM с админкой: клиенты, сделки, таблицы с фильтрами и роли доступа" },
      { name: "Telegram-бот", note: "Команды, сценарии и рассылки", icon: Bot, tier: "team", why: "нужен постоянный серверный процесс", prompt: "Создай Telegram-бота: команды, пошаговые сценарии и рассылка подписчикам" },
      { name: "AI-ассистент", note: "Чат с моделью и базой знаний", icon: Sparkles, tier: "pro", why: "нужны функции и ключ AI-провайдера", prompt: "Создай AI-ассистента: чат с моделью, история диалога и база знаний по документам" },
    ],
  },
];

/**
 * Шаблон не сразу пишет код и не открывает обычный чат: рабочая область показывает окно
 * планирования, где агент задаёт пару вопросов и собирает резюме. Кнопка в этом окне затем
 * переводит его в режим разработчика.
 */
function templateKickoff(group:TemplateGroup,template:Template){
  return `Быстрый старт: ${group.name} → «${template.name}».\n\nЗадача: ${template.prompt}.\n\nЭто первый запрос по новому проекту. Сейчас нужен только план: не изучай файлы, не упоминай, что проект пуст, и не пиши промежуточных рассуждений. Задай через question.ask два коротких вопроса по одному — для кого продукт и какие данные важны; если продукту нужны данные, предложи в этом же вопросе выбрать встроенную базу NestDev, свою базу или работу без базы. Затем спроси про стиль и тон. После ответов собери резюме проекта через plan.update: цель и аудитория, страницы и экраны, данные и выбранная база, интеграции, визуальный стиль, проверка. Все пункты оставь pending и не начинай разработку.`;
}

const planLabels:Record<PlanId,string>={free:"Старт",pro:"Плюс",team:"Премиум"};
const tierLabels:Record<TemplateTier,string>={free:"Старт",pro:"Плюс",team:"Премиум"};

function templateTier(template:Template):TemplateTier{
  return template.tier??"free";
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
  // Какая карточка открыта на странице тарифов: обзор и описание — один маршрут,
  // поэтому переход из окна выбора не теряет загруженный биллинг и работает без перезагрузки.
  const [planDetail,setPlanDetail]=useState<PlanId|null>(null);
  const [plansOpen,setPlansOpen]=useState(false);
  // Вкладка телефона и раздел колонки: выбор раздела на телефоне показывает его сразу,
  // а на ПК та же колонка остаётся рядом с главной страницей.
  const [tab,setTab]=useState<HomeTab>("home");
  // Все категории колонки свёрнуты при открытии: человек сначала видит оглавление, а не его раздел.
  const [section,setSection]=useState<RailSection|null>(null);
  // Старты свёрнуты в аккордеон: сначала видны только категории, а карточки
  // раскрываются по нажатию — так блок остаётся компактным и на телефоне.
  const [activeGroup,setActiveGroup]=useState<string|null>(null);
  const [account,setAccount]=useState<AccountEntitlements|null>(null);
  const [templateNotice,setTemplateNotice]=useState("");
  const entitlements=account?.entitlements??null;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab is a trigger: the active class changes with it
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the payment return is handled once on mount; pick only calls setters
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

  // Тарифные подсказки у шаблонов должны совпадать с тем, что сервер реально разрешает.
  // Если запрос не удался, карточки не блокируем: ограничение проверит агент и сам сервер.
  useEffect(()=>{
    let active=true;
    void getEntitlements()
      .then(data=>{if(active)setAccount(data)})
      .catch(()=>{})
    return ()=>{active=false}
  },[]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: page is a trigger: a new page starts at the top
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
    if(!window.confirm(`Удалить проект «${project.name}»? Его файлы, история, настройки провайдера и загруженные вложения будут удалены.`))return;
    setDeleting(project.id);
    setError("");
    try{
      const result=await deleteProject(project.id);
      setProjects(current=>current.filter(item=>item.id!==project.id));
      if(result.mediaFailed){
        setError("Проект удалён, но часть вложений удалить не удалось. Проверьте хранилище.");
      }
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
    if(await start(value.slice(0,80),{plannerPrompt:ideaKickoff(value),title:value.slice(0,60)}))setIdea("");
  }

  async function exit(){
    try{await logout()}finally{window.location.reload()}
  }

  const openPlans=()=>setPlansOpen(true);
  const openPlanDetails=(plan:PlanId)=>{setPlansOpen(false);setPlanDetail(plan);setPage("subscription")};

  function templateAvailable(template:Template){
    if(!entitlements)return true;
    const tier=templateTier(template);
    if(tier==="team")return entitlements.containerPreview;
    if(tier==="pro")return entitlements.serverlessFunctions;
    return true;
  }

  function chooseTemplate(group:TemplateGroup,template:Template){
    if(!templateAvailable(template)){
      const tier=templateTier(template);
      setTemplateNotice("«"+template.name+"» появится на тарифе «"+tierLabels[tier as Exclude<TemplateTier,"free">]+"»: "+(template.why??"нужны возможности платного тарифа")+".");
      openPlans();
      return;
    }
    setTemplateNotice("");
    void start(template.name,{plannerPrompt:templateKickoff(group,template),title:"Быстрый старт: "+template.name});
  }

  if(page==="subscription")return <>
    <SubscriptionPage
      onBack={()=>{setPlanDetail(null);setPage("home")}}
      selectedPlanId={planDetail}
      onSelectPlan={setPlanDetail}
    />
    <PlanPickerModal open={plansOpen} onClose={()=>setPlansOpen(false)} onChoosePlan={openPlanDetails}/>
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
          {/* На телефоне колонки нет: колокольчик переезжает в строку вкладок, рядом с выходом. */}
          <NotificationsBell variant="tab"/>
          <button className="home-tab-exit" onClick={() => void exit()} title="Выйти" aria-label="Выйти из аккаунта"><LogOut size={14}/></button>
        </nav>

        <div className={"home-main" + (activeRun ? " has-run" : "")}>
          {/* Рабочая область живёт дальше на главной, поэтому запуск виден и здесь. */}
          {activeRun && <div className="home-run" role="status">
            <NestLoader size={24} label="Агент работает"/>
            <div><strong>Агент продолжает работу над проектом «{activeRun.projectName}»</strong></div>
            <button className="ghost-button home-run-open" onClick={() => onOpenWorkspace(activeRun.projectId)}>Вернуться в проект</button>
          </div>}

          <section className="home-hero">
            <div className="home-hero-copy">
              <h1 className="home-title">Из идеи —<br/>в <em>живой продукт.</em></h1>
            </div>
            <div className="home-hero-visual" aria-hidden="true">
              <div className="home-orbit home-orbit-outer"/>
              <div className="home-orbit home-orbit-inner"/>
              <div className="home-hero-mark"><WebNestLogo size={225} tone="light"/></div>
            </div>
          </section>

          <section className="home-composer-wrap">
            <form className="home-composer" onSubmit={submit}>
              <div className="home-composer-top"><div className="home-composer-field"><label className="home-composer-label" htmlFor="home-idea">Опишите идею</label><textarea id="home-idea" value={idea} onChange={e=>setIdea(e.target.value)} rows={3} /></div></div>
              <div className="home-composer-bottom">
                <button className="send-button home-submit" disabled={busy||!idea.trim()} aria-label={busy?"Создаём проект":"Создать проект и запустить агента"} title={busy?"Создаём…":"Отправить идею"}><Code2 size={17}/></button>
              </div>
            </form>
          </section>

          {paymentReturn&&<div className={"home-payment "+paymentReturn} role="status">
            <div>
              <strong>{paymentReturn==="success"?"Оплата принята":"Оплата не прошла"}</strong>
              <span>{paymentReturn==="success"
                ?"Тариф или кредиты обновятся автоматически. Если баланс ещё прежний, обновите через минуту."
                :"Деньги не списаны. Можно вернуться к тарифам и попробовать снова."}</span>
            </div>
            <div className="home-payment-actions">
              <button className="ghost-button" onClick={()=>setPaymentReturn(null)}>Закрыть</button>
              {paymentReturn==="success"&&<button className="send-button" onClick={()=>window.location.reload()}>Обновить</button>}
            </div>
          </div>}

          {error&&<div className="home-error">{error}</div>}

          <section className="home-section home-starters">
            <div className="home-section-head"><div><span className="eyebrow">БЫСТРЫЕ СТАРТЫ</span><h2>С чего начать</h2></div><span className="home-section-note">{account?"Ваш тариф: «"+planLabels[account.plan]+"»":"Готовый бриф · агент уточнит детали"}</span></div>
            <div className="starter-accordion" aria-label="Категории шаблонов">
              {templateGroups.map(group=>{
                const Icon=group.icon;
                const active=activeGroup===group.id;
                return <section className={"starter-group"+(active?" is-open":"")} key={group.id}>
                  <button type="button" className="starter-disclosure" aria-expanded={active} aria-controls={"starter-panel-"+group.id} onClick={()=>{setActiveGroup(active?null:group.id);setTemplateNotice("")}}>
                    <span className="starter-disclosure-icon"><Icon size={15}/></span>
                    <span className="starter-disclosure-copy"><strong>{group.name}</strong><small>{group.range}</small></span>
                    <span className="starter-disclosure-count">{group.templates.length}</span>
                    <ChevronDown size={15} className="starter-disclosure-arrow"/>
                  </button>
                  {active&&<div className="starter-panel" id={"starter-panel-"+group.id}>
                    {templateNotice&&<div className="starter-notice" role="status"><Lock size={13}/><span>{templateNotice}</span><button type="button" onClick={()=>setTemplateNotice("")} aria-label="Закрыть подсказку">×</button></div>}
                    <div className="starter-list">
                      {group.templates.map((template,index)=>{
                        const TemplateIcon=template.icon;
                        const tier=templateTier(template);
                        const available=templateAvailable(template);
                        return <button key={template.name} type="button" className={"starter-card"+(available?"":" is-locked")} onClick={()=>chooseTemplate(group,template)} title={(available?template.prompt:(template.why??"Нужен платный тариф"))+". Агент начнёт с плана и уточняющих вопросов."}>
                          <span className="starter-card-top"><span className="starter-card-icon"><TemplateIcon size={14}/></span><span className="starter-card-index">{String(index+1).padStart(2,"0")}</span><span className={"starter-tier tier-"+tier}>{tier==="team"?<Lock size={9}/>:tier==="pro"?<Sparkles size={9}/>:<Code2 size={9}/>}{tierLabels[tier]}</span></span>
                          <span className="starter-card-copy"><strong>{template.name}</strong><small>{available?template.note:(template.why??"Нужен платный тариф")}</small></span>
                          <span className="starter-card-footer"><span>{available?"Выбрать":"Тариф"}</span><ArrowUpRight size={12} className="starter-card-go"/></span>
                        </button>;
                      })}
                    </div>
                  </div>}
                </section>;
              })}
            </div>
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
            {/* В подвале оставляем только почту: полные реквизиты доступны на странице
                «Реквизиты и контакты» в юридическом разделе. */}
            <div className="home-footer-requisites">
              <a href={"mailto:" + SELLER.email}>{SELLER.email}</a>
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
          onOpenSubscriptions={()=>{setPlanDetail(null);setPage("subscription")}}
          onExit={()=>void exit()}
        />
      </div>
    </main>
    <PlanPickerModal open={plansOpen} onClose={()=>setPlansOpen(false)} onChoosePlan={openPlanDetails}/>
  </>;
}
