import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, History, KeyRound, LogOut, Monitor, PanelLeftClose, PanelLeftOpen, Settings, UserRound } from "lucide-react";
import { getAuth, logout } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";
import { GitHubMark } from "../../components/GitHubMark";
import { getProjectChanges, type ProjectChanges } from "../../lib/project-api";
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
 * проекта, ветка с отметкой GitHub и число сохранённых точек, справа — действия.
 *
 * Выбора проектов здесь нет намеренно: это рабочая область одного проекта, и переключение
 * живёт на главной, где у проектов есть карточки и статусы. Зато видно то, чего не было нигде
 * в рабочей области: в какую ветку уйдут коммиты и подключён ли GitHub. Всё это — один клик
 * в «Изменения», где коммиты и отправляются.
 *
 * Кнопка колонки слева — PanelLeft, а не «бургер»: панель выезжает сбоку, а не раскрывается
 * списком, и иконка должна говорить об этом же.
 */
export function Topbar({projectId,projectName,running,sidebarOpen,onMenu,onHome,onOpenChanges,onSettings,onSecrets,previewOpen,previewRunning,onPreviewToggle}:{projectId:string;projectName:string;running:boolean;sidebarOpen:boolean;onMenu:()=>void;onHome:()=>void;onOpenChanges:()=>void;onSettings:()=>void;onSecrets:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void}){
  const [accountMenu,setAccountMenu]=useState(false);
  const [changes,setChanges]=useState<ProjectChanges|null>(null);
  const [githubConnected,setGithubConnected]=useState(false);
  const [email,setEmail]=useState("");
  const barRef=useRef<HTMLElement|null>(null);

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

  useEffect(()=>{
    let active=true;
    void getAuth().then(state=>{if(active)setEmail(state.user?.yandex?.email||state.user?.email||"")}).catch(()=>{});
    return ()=>{active=false};
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

  // На телефоне предпросмотр — шторка поверх рабочей области с z-index выше шапки: открывая
  // меню, её нужно закрыть, иначе пункты окажутся под шторкой.
  const toggleAccount=()=>{
    if(accountMenu){setAccountMenu(false);return}
    if(previewOpen)onPreviewToggle();
    setAccountMenu(true);
  };

  const repository=changes?.repository;
  const branch=repository?.branch||"main";
  const points=changes?.checkpoints.length??0;
  // Репозиторий проекта и аккаунт GitHub — разные вещи: аккаунт может быть подключён, а
  // репозиторий у проекта ещё не создан. Светлый знак и счётчик непушнутых точек относятся
  // именно к репозиторию проекта, иначе шапка обещала бы отправку, которой некуда идти.
  const repoConnected=Boolean(repository?.connected);
  const unpushed=repoConnected?(changes?.checkpoints??[]).filter(item=>!item.pushed).length:0;
  const account=accountLabel(email);
  const repoTitle="Ветка "+branch+(!repoConnected
    ?(githubConnected?" · GitHub подключён, репозиторий проекта ещё не создан":" · GitHub не подключён — подключить в «Изменениях»")
    :(unpushed>0?" · GitHub · не отправлено: "+pointsLabel(unpushed):" · репозиторий на GitHub"));

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
      <span className="topbar-sep" aria-hidden="true">›</span>
      <button className="topbar-chip topbar-repo" onClick={onOpenChanges} title={repoTitle}>
        <GitBranch size={12}/>
        <span className="topbar-chip-text">{branch}</span>
        <i className="topbar-chip-sep" aria-hidden="true"/>
        <span className={"topbar-chip-github"+(repoConnected?"":" is-off")}><GitHubMark size={12}/></span>
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
      <button className="icon-button" onClick={onSettings} title="Настройки и тариф" aria-label="Настройки и тариф"><Settings size={15}/></button>
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
          <button role="menuitem" className="topbar-menu-item" onClick={()=>{setAccountMenu(false);onSettings()}}>
            <span className="topbar-menu-name">Аккаунт и тариф</span><Settings size={13}/>
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
