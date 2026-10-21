import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, History, KeyRound, LogOut, Monitor, PanelLeftClose, PanelLeftOpen, Settings, UserRound } from "lucide-react";
import { getAuth, logout } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";
import { GitHubMark } from "../../components/GitHubMark";
import { getProjectChanges, listProjectBranches, switchProjectBranch, type ProjectBranches, type ProjectChanges } from "../../lib/project-api";
import { getGitHubStatus } from "../../lib/github-api";

/**
 * Подпись аккаунта в меню. Вход чаще всего по номеру телефона, и служебный адрес вида
 * 79990000000@phone.local в меню читался бы как техническая строка — номер показывается
 * привычными группами, а обычный email остаётся как есть.
 */
function accountLabel(email:string){
  if(!email)return {name:"Аккаунт",detail:"вход выполнен"};
  const [local,domain]=email.split("@");
  if(domain&&domain.startsWith("phone.")&&/^\d{11}$/.test(local)){
    return {name:"+"+local[0]+" "+local.slice(1,4)+" "+local.slice(4,7)+"-"+local.slice(7,9)+"-"+local.slice(9,11),detail:"вход по номеру телефона"};
  }
  return {name:local,detail:email};
}

/** «1 точка», «2 точки», «5 точек» — счётчик истории в чипе читается по-русски. */
function pointsLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return count + " точка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return count + " точки";
  return count + " точек";
}

/**
 * Шапка рабочей области — полоса пути, как в IDE: знак ведёт на главную, дальше название
 * проекта, ветка, число сохранённых точек и статус GitHub справа — действия.
 *
 * Ветка — это кнопка, а не подпись: отправка уходит в текущую ветку, поэтому клик по ней
 * раскрывает список веток проекта, и выбор сразу переключает проект. Раньше здесь стоял
 * отдельный значок GitHub, хотя подключение к GitHub — не то, что человек ищет в пути.
 *
 * Кнопка колонки слева — PanelLeft, а не «бургер»: панель выезжает сбоку, а не раскрывается
 * списком, и иконка должна говорить об этом же.
 */
export function Topbar({projectId,projectName,running,sidebarOpen,onMenu,onHome,onOpenChanges,onSettings,onSecrets,previewOpen,previewRunning,onPreviewToggle,onRepositoryChanged}:{projectId:string;projectName:string;running:boolean;sidebarOpen:boolean;onMenu:()=>void;onHome:()=>void;onOpenChanges:()=>void;onSettings:()=>void;onSecrets:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void;onRepositoryChanged?:()=>void}){
  const [accountMenu,setAccountMenu]=useState(false);
  const [branchMenu,setBranchMenu]=useState(false);
  const [branches,setBranches]=useState<ProjectBranches|null>(null);
  const [branchBusy,setBranchBusy]=useState("");
  const [branchError,setBranchError]=useState("");
  const [changes,setChanges]=useState<ProjectChanges|null>(null);
  const [githubConnected,setGithubConnected]=useState(false);
  const [email,setEmail]=useState("");
  const barRef=useRef<HTMLElement|null>(null);
  const branchRef=useRef<HTMLDivElement|null>(null);

  // Ветка, история и состояние GitHub обновляются при возврате на вкладку: запуск агента
  // и подключение репозитория заканчиваются, пока человек работает в другом окне, и шапка
  // должна показать это без перезагрузки.
  const loadRepository=useCallback(async()=>{
    if(!projectId)return;
    try{setChanges(await getProjectChanges(projectId))}catch{}
    try{setGithubConnected(Boolean((await getGitHubStatus()).connected))}catch{}
  },[projectId]);

  useEffect(()=>{void loadRepository()},[loadRepository]);
  useEffect(()=>{
    const onFocus=()=>void loadRepository();
    window.addEventListener("focus",onFocus);
    return ()=>window.removeEventListener("focus",onFocus);
  },[loadRepository]);

  // Список веток читается при открытии меню, а не при каждой загрузке шапки: он нужен
  // только тому, кто собирается переключить ветку.
  useEffect(()=>{
    if(!branchMenu)return;
    let active=true;
    setBranchError("");
    void listProjectBranches(projectId)
      .then(data=>{if(active)setBranches(data)})
      .catch(error=>{if(active)setBranchError(error instanceof Error?error.message:String(error))});
    return ()=>{active=false};
  },[branchMenu,projectId]);

  useEffect(()=>{
    let active=true;
    void getAuth().then(state=>{if(active)setEmail(state.user?.yandex?.email||state.user?.email||"")}).catch(()=>{});
    return ()=>{active=false}
  },[]);

  // Меню закрывается нажатием вне шапки и по Escape — как выезжающая колонка.
  useEffect(()=>{
    if(!accountMenu)return;
    const onPointer=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target&&barRef.current?.contains(target))return;
      setAccountMenu(false);
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")setAccountMenu(false)};
    document.addEventListener("pointerdown",onPointer,true);
    window.addEventListener("keydown",onKey);
    return ()=>{
      document.removeEventListener("pointerdown",onPointer,true);
      window.removeEventListener("keydown",onKey);
    };
  },[accountMenu]);

  useEffect(()=>{
    if(!branchMenu)return;
    const onPointer=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target&&branchRef.current?.contains(target))return;
      setBranchMenu(false);
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")setBranchMenu(false)};
    document.addEventListener("pointerdown",onPointer,true);
    window.addEventListener("keydown",onKey);
    return ()=>{
      document.removeEventListener("pointerdown",onPointer,true);
      window.removeEventListener("keydown",onKey);
    };
  },[branchMenu]);

  // На телефоне предпросмотр — шторка поверх рабочей области с z-index выше шапки: открывая
  // меню, её нужно закрыть, иначе пункты окажутся под шторкой.
  const toggleAccount=()=>{
    if(accountMenu){setAccountMenu(false);return}
    if(previewOpen)onPreviewToggle();
    setBranchMenu(false);
    setAccountMenu(true);
  };
  const toggleBranch=()=>{
    if(branchMenu){setBranchMenu(false);return}
    if(previewOpen)onPreviewToggle();
    setAccountMenu(false);
    setBranchMenu(true);
  };

  /**
   * Выбор ветки. Переключение меняет файлы проекта, поэтому после ответа сервера шапка
   * берёт историю уже новой ветки, а рабочая область перечитывает предпросмотр.
   */
  const chooseBranch=async(name:string)=>{
    if(branchBusy)return;
    setBranchBusy(name);
    setBranchError("");
    try{
      const result=await switchProjectBranch(projectId,name);
      if(!result.switched){
        setBranchError(result.error??"Не удалось переключить ветку");
        return;
      }
      setChanges(result.overview);
      setBranches(current=>current?{...current,current:result.overview.repository.branch,branches:current.branches.map(item=>({...item,current:item.name===result.overview.repository.branch}))}:current);
      setBranchMenu(false);
      onRepositoryChanged?.();
    }catch(error){
      setBranchError(error instanceof Error?error.message:String(error));
    }finally{
      setBranchBusy("");
    }
  };

  const repository=changes?.repository;
  const branch=repository?.branch||"main";
  const points=changes?.checkpoints.length??0;
  // Репозиторий проекта и аккаунт GitHub — разные вещи: аккаунт может быть подключён, а
  // репозиторий у проекта ещё не создан. Неотправленные точки относятся именно к репозиторию
  // проекта, иначе шапка обещала бы отправку, которой некуда идти.
  const repoConnected=Boolean(repository?.connected);
  const unpushed=repoConnected?(changes?.checkpoints??[]).filter(item=>!item.pushed).length:0;
  const account=accountLabel(email);
  const repoTitle="GitHub"+(!repoConnected
    ?(githubConnected?" подключён, репозиторий проекта ещё не создан":" не подключён — подключить в «Изменениях»")
    :(unpushed>0?" · не отправлено: "+pointsLabel(unpushed):" · репозиторий проекта"));
  const branchTitle="Ветка "+branch+" · выбрать другую ветку проекта";

  return <header className="topbar" ref={barRef}>
    <button className="icon-button mobile-only menu-toggle" onClick={onMenu} aria-label={sidebarOpen?"Закрыть панель":"Открыть панель"} aria-expanded={sidebarOpen} aria-controls="workspace-sidebar">
      {sidebarOpen?<PanelLeftClose size={18}/>:<PanelLeftOpen size={18}/>}
    </button>
    <button className="brand brand-home" onClick={onHome} title="На главную">
      <span className="brand-mark"><WebNestLogo size={44} tone="light"/></span>
      <span className="brand-name">NestDev</span>
    </button>

    <div className="topbar-trail">
      <span className="topbar-crumb" title={"Проект: "+projectName}>
        <span className={"topbar-dot"+(running?" is-live":"")} aria-hidden="true"/>
        <span className="topbar-project-name">{projectName}</span>
      </span>
      {/* Ветка называется прямо в шапке: клик открывает список веток проекта, и выбор сразу
          переключает рабочую область — следующая отправка уйдёт уже в выбранную ветку. */}
      <div className="topbar-branch" ref={branchRef}>
        <button className="topbar-branch-button" onClick={toggleBranch} aria-haspopup="menu" aria-expanded={branchMenu} aria-controls="topbar-branch-menu" title={branchTitle} aria-label={"Ветка "+branch+": выбрать другую"}>
          <GitBranch size={12}/>
          <span className="topbar-branch-name">{branch}</span>
          <ChevronDown size={11} className="topbar-branch-caret"/>
          {unpushed>0&&<i className="topbar-branch-dot" aria-hidden="true"/>}
        </button>
        {branchMenu&&<div className="topbar-menu topbar-menu-branch" id="topbar-branch-menu" role="menu" aria-label="Ветки проекта">
          <span className="topbar-menu-label">ВЕТКИ ПРОЕКТА</span>
          {branchError&&<p className="topbar-branch-error" role="alert">{branchError}</p>}
          <div className="topbar-branch-list">
            {!branches&&!branchError&&<span className="topbar-branch-empty">Загружаем ветки…</span>}
            {branches&&branches.branches.length===0&&<span className="topbar-branch-empty">{branches.initialized?"В проекте пока только ветка "+branch+".":"История ещё не создана: первая задача создаст ветку "+branch+"."}</span>}
            {branches?.branches.map(item=><button
              key={item.name}
              role="menuitemradio"
              aria-checked={item.current}
              className={"topbar-branch-item"+(item.current?" is-current":"")}
              onClick={()=>{if(item.current){setBranchMenu(false);return}void chooseBranch(item.name)}}
              disabled={Boolean(branchBusy)}
              title={item.remote?"Ветка есть на GitHub":"Ветка только в проекте"}
            >
              <GitBranch size={12}/>
              <span className="topbar-branch-item-name">{item.name}</span>
              {item.remote&&<span className="topbar-branch-tag">GitHub</span>}
              {item.current
                ?<Check size={12} className="topbar-branch-check"/>
                :item.pushed?<span className="topbar-branch-synced" title="Ветка отправлена на GitHub">·</span>:null}
            </button>)}
          </div>
          <div className="topbar-menu-foot">
            <button role="menuitem" className="topbar-menu-item" onClick={()=>{setBranchMenu(false);onOpenChanges()}}>
              <span className="topbar-menu-name">Изменения и отправка</span><History size={13}/>
            </button>
          </div>
        </div>}
      </div>
      <span className="topbar-sep" aria-hidden="true">›</span>
      <button className="topbar-chip topbar-github-chip" onClick={onOpenChanges} title={repoTitle+" — открыть «Изменения»"} aria-label="GitHub и отправка изменений">
        <GitHubMark size={12}/>
        <span className="topbar-chip-text">GitHub</span>
        {unpushed>0&&<i className="topbar-chip-dot" aria-hidden="true"/>}
      </button>
      {/* Ноль не показывается: пустая история — это отсутствие новости, а не новость. */}
      {points>0&&<button className="topbar-chip" onClick={onOpenChanges} title={"История изменений: "+pointsLabel(points)+" — открыть «Изменения»"}>
        <History size={12}/>
        <span className="topbar-chip-count">{points}</span>
      </button>}
    </div>

    <div className="topbar-actions">
      {/* Only on a phone, where the preview is a drawer and needs a way in and out. */}
      <button className={"icon-button preview-toggle"+(previewOpen?" active":"")} onClick={onPreviewToggle} aria-expanded={previewOpen} aria-controls="preview-panel" aria-label="Предпросмотр проекта" title="Предпросмотр проекта">
        <Monitor size={16}/>
        {previewRunning&&<span className="preview-toggle-dot" aria-hidden="true"/>}
      </button>
      <span className="topbar-divider" aria-hidden="true"/>
      <button className="icon-button" onClick={onSecrets} title="Секреты проекта" aria-label="Секреты проекта"><KeyRound size={15}/></button>
      <div className="topbar-account">
        <button className={"topbar-avatar"+(accountMenu?" open":"")} onClick={toggleAccount} aria-haspopup="menu" aria-expanded={accountMenu} aria-controls="topbar-account-menu" aria-label="Аккаунт и выход" title={account.detail}>
          <UserRound size={15}/>
        </button>
        {accountMenu&&<div className="topbar-menu topbar-menu-account" id="topbar-account-menu" role="menu" aria-label="Аккаунт">
          <span className="topbar-menu-label">АККАУНТ</span>
          <div className="topbar-account-head">
            <span className="topbar-account-mark"><UserRound size={14}/></span>
            <div><strong>{account.name}</strong><small>{account.detail}</small></div>
          </div>
          {/* Настройки живут здесь, а не отдельной шестерёнкой в полосе действий: это меню
              аккаунта, и шестерёнка рядом с «Аккаунт и тариф» читается как его продолжение. */}
          <button role="menuitem" className="topbar-menu-item" onClick={()=>{setAccountMenu(false);onSettings()}}>
            <span className="topbar-menu-name">Настройки, аккаунт и тариф</span><Settings size={13}/>
          </button>
          <button role="menuitem" className="topbar-menu-item" onClick={()=>{setAccountMenu(false);onSecrets()}}>
            <span className="topbar-menu-name">Секреты проекта</span><KeyRound size={13}/>
          </button>
          <div className="topbar-menu-foot">
            <button role="menuitem" className="topbar-menu-item danger" onClick={async()=>{await logout();window.location.reload()}}>
              <span className="topbar-menu-name">Выйти</span><LogOut size={13}/>
            </button>
          </div>
        </div>}
      </div>
    </div>
  </header>;
}
