import { useCallback, useEffect, useState } from "react";
import { History, Monitor, PanelLeftClose, PanelLeftOpen, Rocket } from "lucide-react";
import { WebNestLogo } from "../../components/WebNestLogo";
import { GitHubMark } from "../../components/GitHubMark";
import { getProjectChanges, type ProjectChanges } from "../../lib/project-api";
import { getGitHubStatus } from "../../lib/github-api";
import { NotificationsBell } from "../notifications/NotificationsBell";

/** «1 точка», «2 точки», «5 точек» — счётчик истории в чипе читается по-русски. */
function pointsLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return count + " точка";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return count + " точки";
  return count + " точек";
}

/**
 * Шапка рабочей области — полоса пути, как в IDE: знак ведёт на главную, дальше статус GitHub
 * и число сохранённых точек.
 *
 * Название проекта живёт в колонке слева: там же его можно переименовать. В шапке оно делило
 * место с действиями и на телефоне обрезалось, а в колонке видно, в каком проекте открыт чат.
 *
 * Выбора ветки здесь нет: он дублировал вкладку «Изменения» и занимал место в шапке. Ветка,
 * переключение и создание живут там, рядом с отправкой.
 *
 * Кнопка колонки слева — PanelLeft, а не «бургер»: панель выезжает сбоку, а не раскрывается
 * списком, и иконка должна говорить об этом же.
 */
export function Topbar({projectId,sidebarOpen,onMenu,onHome,onOpenChanges,onDeploy,previewOpen,previewRunning,onPreviewToggle}:{projectId:string;sidebarOpen:boolean;onMenu:()=>void;onHome:()=>void;onOpenChanges:()=>void;onDeploy:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void}){
  const [changes,setChanges]=useState<ProjectChanges|null>(null);
  const [githubConnected,setGithubConnected]=useState(false);

  // История и состояние GitHub обновляются при возврате на вкладку: запуск агента
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

  const repository=changes?.repository;
  const points=changes?.checkpoints.length??0;
  // Репозиторий проекта и аккаунт GitHub — разные вещи: аккаунт может быть подключён, а
  // репозиторий у проекта ещё не создан. Неотправленные точки относятся именно к репозиторию
  // проекта, иначе шапка обещала бы отправку, которой некуда идти.
  const repoConnected=Boolean(repository?.connected);
  const pushAllowed=repository?.pushAllowed!==false;
  // На бесплатном тарифе точки не «ждут отправки»: отправка закрыта, и мигающая точка
  // в шапке обещала бы действие, которого нет.
  const unpushed=repoConnected&&pushAllowed?(changes?.checkpoints??[]).filter(item=>!item.pushed).length:0;
  const repoTitle="GitHub"+(!repoConnected
    ?(githubConnected?" подключён, репозиторий проекта ещё не создан":" не подключён — подключить в «Изменениях»")
    :!pushAllowed?" · отправка закрыта на бесплатном тарифе"
    :(unpushed>0?" · не отправлено: "+pointsLabel(unpushed):" · репозиторий проекта"));
  return <header className="topbar">
    <button className="icon-button mobile-only menu-toggle" onClick={onMenu} aria-label={sidebarOpen?"Закрыть панель":"Открыть панель"} aria-expanded={sidebarOpen} aria-controls="workspace-sidebar">
      {sidebarOpen?<PanelLeftClose size={18}/>:<PanelLeftOpen size={18}/>}
    </button>
    <button className="brand brand-home" onClick={onHome} title="На главную">
      <span className="brand-mark"><WebNestLogo size={44} tone="light"/></span>
      <span className="brand-name">NestDev</span>
    </button>

    <div className="topbar-trail">
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
      {/* Подарок администратора или выданный тариф видны здесь: счётчик не должен теряться
          среди меню аккаунта, иначе баланс меняется молча. */}
      <NotificationsBell variant="topbar"/>
      {/* Развёртывание — главное действие в шапке: квиз открывается поверх рабочей области.
          Ключи переехали в строку вкладок, где у них есть подпись. */}
      <button className="icon-button topbar-deploy" onClick={onDeploy} title="Развернуть проект: собрать параметры и передать агенту" aria-label="Развернуть проект"><Rocket size={15}/></button>
    </div>
  </header>;
}
