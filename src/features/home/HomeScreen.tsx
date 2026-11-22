import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUpRight, Code2, CreditCard, FolderGit2, Home, Lock, Pencil, Plug, Sparkles, Trash2, UserRound } from "lucide-react";
import { TemplatePreview, type TemplatePreviewKind } from "./TemplatePreview";
import { deleteProject, listProjects, renameProject, type Project } from "../../lib/project-api";
import type { PlanId } from "../../lib/billing-api";
import { getEntitlements, type AccountEntitlements } from "../../lib/entitlements-api";
import { logout } from "../../lib/auth-api";
import { HomeRail, type RailSection } from "./HomeRail";
import { AccountSettingsPanel } from "../settings/AccountSettingsPanel";
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
type Template = { name: string; note: string; prompt: string; preview: TemplatePreviewKind; tier?: Exclude<TemplateTier, "free">; why?: string; featured?: boolean };
type TemplateGroup = { id: string; name: string; short: string; blurb: string; templates: Template[] };

/**
 * Категории шаблонов отвечают на два разных вопроса: «что здесь вообще можно собрать» —
 * заголовок и описание, «с чего начать прямо сейчас» — карточки внутри. Шаблон выбирают
 * глазами, поэтому вместо раскрывающегося списка — полка с превью и фильтрами по направлению.
 */
const templateGroups: TemplateGroup[] = [
  {
    id: "sites", name: "Сайты", short: "Сайты",
    blurb: "От одной страницы с оффером до маркетплейса с продавцами, каталогом, корзиной и оплатой.",
    templates: [
      { name: "Лендинг", note: "Одна страница: оффер, преимущества, заявка", preview: "landing", featured: true, prompt: "Создай современный лендинг для продукта: первый экран с оффером, преимущества, отзывы, блок с ценами и форма заявки" },
      { name: "Корпоративный сайт", note: "Несколько страниц, услуги, команда и контакты", preview: "corporate", prompt: "Создай корпоративный сайт компании: главная, услуги, о компании, кейсы и контакты, с общим меню и адаптивом" },
      { name: "Интернет-магазин", note: "Каталог, карточки, корзина и оформление заказа", preview: "shop", featured: true, tier: "pro", why: "нужны функции и база для заказов", prompt: "Создай интернет-магазин: каталог с фильтрами, карточка товара, корзина и оформление заказа" },
      { name: "Маркетплейс", note: "Продавцы, категории, заказы и кабинеты", preview: "marketplace", tier: "pro", why: "нужны роли, заказы и база", prompt: "Создай маркетплейс: продавцы, категории, карточки товаров, заказы и кабинеты покупателя и продавца" },
      { name: "Блог или медиа", note: "Статьи, рубрики, поиск и подписка", preview: "blog", prompt: "Создай сайт-блог или медиа: лента статей, рубрики, страница статьи, поиск и подписка на обновления" },
    ],
  },
  {
    id: "apps", name: "Приложения", short: "Приложения",
    blurb: "Экраны под телефон, установка из браузера, Mini App внутри Telegram и SaaS-кабинет с подпиской.",
    templates: [
      { name: "Мобильное приложение", note: "Экраны для Android и iOS с навигацией", preview: "mobile", featured: true, prompt: "Создай мобильное приложение для Android и iOS: 4–6 экранов с навигацией, списками и сохранением данных" },
      { name: "PWA", note: "Устанавливается из браузера, работает офлайн", preview: "pwa", prompt: "Создай PWA: устанавливается из браузера, работает офлайн, показывает уведомления и хранит данные на устройстве" },
      { name: "Telegram Mini App", note: "Интерфейс внутри Telegram с профилем", preview: "telegram", prompt: "Создай Telegram Mini App: интерфейс внутри Telegram, профиль пользователя, основные действия и адаптация под телефон" },
      { name: "SaaS-сервис", note: "Аккаунты, тарифы и личный кабинет", preview: "saas", tier: "pro", why: "нужны аккаунты, база и функции", prompt: "Создай SaaS-сервис: регистрация, тарифы, личный кабинет и основная рабочая функция" },
    ],
  },
  {
    id: "games", name: "Игры и 3D", short: "Игры и 3D",
    blurb: "Браузерные игры и объёмные сцены: управление, уровни, счёт и эффекты — без установки.",
    templates: [
      { name: "3D-игра", note: "Сцена, управление, цели и счёт", preview: "game3d", prompt: "Создай браузерную 3D-игру: управление, цели, счёт и перезапуск раунда" },
      { name: "2D-игра", note: "Аркада с уровнями и рекордами", preview: "game2d", featured: true, prompt: "Создай браузерную 2D-игру: уровни, управление, счёт и таблица рекордов" },
      { name: "3D-витрина", note: "Товар или объект, который можно вращать", preview: "showcase3d", prompt: "Создай интерактивную 3D-витрину: объект или товар, вращение, ракурсы и подписи" },
    ],
  },
  {
    id: "data", name: "Данные и автоматизация", short: "Данные и AI",
    blurb: "Графики, таблицы, роли, боты и ассистенты — внутренние инструменты, которые сразу работают.",
    templates: [
      { name: "Дашборд", note: "Метрики, графики и фильтры", preview: "dashboard", featured: true, prompt: "Создай аналитический дашборд: метрики, графики, фильтры и таблица последних событий" },
      { name: "CRM и админка", note: "Клиенты, таблицы и роли доступа", preview: "crm", tier: "pro", why: "нужны база, функции и роли", prompt: "Создай CRM с админкой: клиенты, сделки, таблицы с фильтрами и роли доступа" },
      { name: "Telegram-бот", note: "Команды, сценарии и рассылки", preview: "bot", tier: "team", why: "нужен постоянный серверный процесс", prompt: "Создай Telegram-бота: команды, пошаговые сценарии и рассылка подписчикам" },
      { name: "AI-ассистент", note: "Чат с моделью и базой знаний", preview: "ai", featured: true, tier: "pro", why: "нужны функции и ключ AI-провайдера", prompt: "Создай AI-ассистента: чат с моделью, история диалога и база знаний по документам" },
    ],
  },
];

/** Фильтры над полкой: «для вас» — отобранное, «все» и по одному на каждое направление. */
const starterFilters: Array<{ id: string; label: string }> = [
  { id: "featured", label: "Для вас" },
  { id: "all", label: "Все" },
  ...templateGroups.map(group => ({ id: group.id, label: group.short })),
];

/** Карточки выбранного фильтра. «Для вас» смешивает направления, но остаётся одной строкой. */
function starterItemsFor(filter: string) {
  if (filter === "featured") {
    return templateGroups.flatMap(group => group.templates.filter(template => template.featured).map(template => ({ group, template })));
  }
  const groups = filter === "all" ? templateGroups : templateGroups.filter(group => group.id === filter);
  return groups.flatMap(group => group.templates.map(template => ({ group, template })));
}

/**
 * Шаблон не сразу пишет код и не открывает обычный чат: рабочая область показывает окно
 * планирования, где агент задаёт пару вопросов и собирает резюме. Кнопка в этом окне затем
 * переводит его в режим разработчика.
 */
function templateKickoff(group:TemplateGroup,template:Template){
  return `Быстрый старт: ${group.name} → «${template.name}».\n\nЗадача: ${template.prompt}.\n\nЭто первый запрос по новому проекту. Сейчас нужен только план: не изучай файлы, не упоминай, что проект пуст, и не пиши промежуточных рассуждений. Задай через question.ask два коротких вопроса по одному — для кого продукт и какие данные важны; если продукту нужны данные, предложи в этом же вопросе выбрать встроенную базу NestDev, свою базу или работу без базы. Затем спроси про стиль и тон. После ответов собери резюме проекта через plan.update: цель и аудитория, страницы и экраны, данные и выбранная база, интеграции, визуальный стиль, проверка. Все пункты оставь pending и не начинай разработку.`;
}

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
  // Полка шаблонов открыта на «Для вас»: примеры видны сразу, а фильтры переключают
  // направление, не раскрывая блок заново (как список стартов в референсе).
  const [starterFilter,setStarterFilter]=useState("featured");
  const [account,setAccount]=useState<AccountEntitlements|null>(null);
  const [templateNotice,setTemplateNotice]=useState("");
  const entitlements=account?.entitlements??null;
  // Возврат со страницы оплаты: платёжная система переводит браузер сюда с отметкой в адресе.
  const [paymentReturn,setPaymentReturn]=useState<"success"|"fail"|null>(null);

  const tabsRef = useRef<HTMLDivElement | null>(null);
  // Каждая смена фильтра открывает полку с начала: иначе после прокрутки вправо новая
  // категория выглядит пустой, потому что её карточки остались левее видимой части.
  const galleryRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: фильтр — это триггер: смена набора карточек возвращает полку в начало
  useEffect(()=>{
    galleryRef.current?.scrollTo({left:0});
  },[starterFilter]);

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
  // Важно двигать только сам трек: scrollIntoView мог прокрутить ещё и страницу по горизонтали,
  // из-за чего контент оплаты/аккаунта уезжал вбок.
  useEffect(() => {
    const track = tabsRef.current;
    const active = track?.querySelector<HTMLElement>(".home-tab.active");
    if (!track || !active) return;
    const trackRect = track.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const left = track.scrollLeft + activeRect.left - trackRect.left - (track.clientWidth - activeRect.width) / 2;
    track.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
    // Новый раздел открываем с начала, а не с той высоты, на которой осталась предыдущая
    // страница. На ПК это особенно важно для полной страницы аккаунта.
    if (tab === "account" || window.matchMedia("(max-width: 900px)").matches) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
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
  const activeProject=projects.find(project=>project.id===activeProjectId)??null;
  const starterItems=starterItemsFor(starterFilter);
  const starterGroup=templateGroups.find(group=>group.id===starterFilter)??null;
  const starterHint=starterGroup?.blurb??"По одному шаблону из каждого направления";

  return <>
    <main className="home-screen">
      <div className="home-layout" data-tab={tab}>
        {/* Только на телефоне: там разделы переключаются вкладками, как колонка рядом с ПК. */}
        <nav className="home-tabs" aria-label="Разделы главной">
          <div className="home-tabs-track" ref={tabsRef}>
            {homeTabs.map(item => {
              const Icon = item.icon;
              return <button key={item.id} className={"home-tab" + (tab === item.id ? " active" : "")} onClick={() => pick(item.id)} aria-current={tab === item.id ? true : undefined}>
                <span className="home-tab-icon"><Icon size={14}/></span>
                <span className="home-tab-label">{item.label}</span>
              </button>;
            })}
          </div>
          {/* На телефоне колонки нет: колокольчик занимает место, где раньше был выход.
              Сам выход теперь живёт в разделе «Аккаунт». */}
          <NotificationsBell variant="tab"/>
        </nav>

        <div className={"home-main" + (activeRun ? " has-run" : "")}>
          {/* Аккаунт — не краткая справка в узкой колонке, а тот же полный раздел
              «Настройки аккаунта», что и в рабочем кабинете: профиль, тарифы, база, безопасность. */}
          {tab === "account" && <div className="home-account-view">
            <AccountSettingsPanel projectId={activeProject?.id} projectName={activeProject?.name} onLogout={()=>void exit()}/>
          </div>}

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
              <div className="home-composer-field">
                <label className="home-composer-label" htmlFor="home-idea">Опишите идею</label>
                <textarea id="home-idea" value={idea} onChange={e=>setIdea(e.target.value)} rows={2} placeholder="Например: магазин керамики с каталогом, оплатой и доставкой"/>
              </div>
              <button className="send-button home-submit" disabled={busy||!idea.trim()} aria-label={busy?"Создаём проект":"Создать проект и запустить агента"} title={busy?"Создаём…":"Создать проект"}>
                <span>{busy?"Создаём…":"Создать"}</span><ArrowUpRight size={16}/>
              </button>
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

          <section className="home-starters" aria-labelledby="home-starters-title">
            <div className="starter-dock-head">
              <div><span className="eyebrow">БЫСТРЫЕ СТАРТЫ</span><h2 id="home-starters-title">Начните с шаблона</h2></div>
              <span className="starter-dock-hint">{starterHint}</span>
            </div>
            <div className="starter-filters" role="group" aria-label="Категории шаблонов">
              {starterFilters.map(filter=><button
                key={filter.id}
                type="button"
                className={"starter-filter"+(starterFilter===filter.id?" is-active":"")}
                aria-pressed={starterFilter===filter.id}
                onClick={()=>{setStarterFilter(filter.id);setTemplateNotice("")}}
              >{filter.label}</button>)}
            </div>
            {templateNotice&&<div className="starter-notice" role="status"><Lock size={13}/><span>{templateNotice}</span><button type="button" onClick={()=>setTemplateNotice("")} aria-label="Закрыть подсказку">×</button></div>}
            <div className="starter-gallery" role="region" aria-label="Шаблоны" ref={galleryRef}>
              {starterItems.map(({group,template})=>{
                const tier=templateTier(template);
                const available=templateAvailable(template);
                return <button
                  key={group.id+"-"+template.name}
                  type="button"
                  className={"starter-card"+(available?"":" is-locked")}
                  onClick={()=>chooseTemplate(group,template)}
                  title={(available?template.prompt:(template.why??"Нужен платный тариф"))+". Агент начнёт с плана и уточняющих вопросов."}
                >
                  <span className="starter-shot"><TemplatePreview kind={template.preview}/></span>
                  <span className="starter-card-foot">
                    <strong className="starter-card-name">{template.name}</strong>
                    <span className={"starter-tier tier-"+tier}>{tier==="team"?<Lock size={9}/>:tier==="pro"?<Sparkles size={9}/>:<Code2 size={9}/>}{tierLabels[tier]}</span>
                  </span>
                  <span className="starter-card-note">{available?template.note:(template.why??"Нужен платный тариф")}</span>
                </button>;
              })}
            </div>
          </section>

          {projects.length>0&&<section className="home-section">
            <div className="home-section-head"><div><span className="eyebrow">ВАШИ ПРОЕКТЫ</span><h2>Последние проекты</h2></div><button className="home-link" onClick={()=>void start("Новый проект")}>Новый проект <ArrowRight size={13}/></button></div>
            <div className="recent-grid">{projects.slice(0,6).map((project,index)=>{
              const initial=project.name.trim().slice(0,1).toUpperCase()||"N";
              return <div key={project.id} className="recent-card">
                {renaming===project.id
                  ? <ProjectRenameForm initial={project.name} onSubmit={name=>void rename(project,name)} onCancel={()=>setRenaming("")}/>
                  : <button className="recent-open" onClick={()=>open(project)} title={"Открыть проект «"+project.name+"»"}>
                      <span className="recent-thumb" aria-hidden="true">{initial}</span>
                      <span className="recent-copy"><span className="recent-index">Проект {String(index+1).padStart(2,"0")}</span><strong>{project.name}</strong></span>
                      <ArrowUpRight size={13} className="recent-go" aria-hidden="true"/>
                    </button>}
                {renaming!==project.id&&<div className="recent-tools">
                  <button onClick={()=>setRenaming(project.id)} title="Переименовать" aria-label={"Переименовать проект "+project.name}><Pencil size={12}/></button>
                  <button className="danger" onClick={()=>void remove(project)} disabled={deleting===project.id} title="Удалить проект" aria-label={"Удалить проект "+project.name}><Trash2 size={12}/></button>
                </div>}
              </div>;
            })}</div>
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
        />
      </div>
    </main>
    <PlanPickerModal open={plansOpen} onClose={()=>setPlansOpen(false)} onChoosePlan={openPlanDetails}/>
  </>;
}
