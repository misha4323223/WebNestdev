import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, History, Monitor, PanelLeftClose, PanelLeftOpen, Rocket } from "lucide-react";
import { WebNestLogo } from "../../components/WebNestLogo";
import { GitHubMark } from "../../components/GitHubMark";
import { getProjectChanges, listProjectBranches, switchProjectBranch, type ProjectBranches, type ProjectChanges } from "../../lib/project-api";
import { getGitHubStatus } from "../../lib/github-api";
import { NotificationsBell } from "../notifications/NotificationsBell";

/**
 * Имя репозитория из адреса: `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`
 * и `…/owner/repo` дают одно и то же `repo`. В шапке нужно имя, а не полный адрес: владелец
 * остаётся в подсказке и в «Изменениях».
 */
function repositoryName(remoteUrl: string | null | undefined) {
  const raw = remoteUrl?.trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@[^:/]+[:/]/i, "");
  return cleaned.split(/[\\/]/).filter(Boolean).pop() ?? "";
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
 * Шапка рабочей области — полоса пути, как в IDE: знак ведёт на главную, дальше статус GitHub
 * и число сохранённых точек; ветка стоит у действий, рядом с предпросмотром.
 *
 * Название проекта живёт в колонке слева: там же его можно переименовать. В шапке оно делило
 * место с действиями и на телефоне обрезалось, а в колонке видно, в каком проекте открыт чат.
 *
 * Ветка — это кнопка, а не подпись: отправка уходит в текущую ветку, поэтому клик по ней
 * раскрывает список веток проекта, и выбор сразу переключает проект. Раньше здесь стоял
 * отдельный значок GitHub, хотя подключение к GitHub — не то, что человек ищет в пути.
 *
 * Кнопка колонки слева — PanelLeft, а не «бургер»: панель выезжает сбоку, а не раскрывается
 * списком, и иконка должна говорить об этом же.
 */
export function Topbar({projectId,sidebarOpen,onMenu,onHome,onOpenChanges,onDeploy,previewOpen,previewRunning,onPreviewToggle,onRepositoryChanged}:{projectId:string;sidebarOpen:boolean;onMenu:()=>void;onHome:()=>void;onOpenChanges:()=>void;onDeploy:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void;onRepositoryChanged?:()=>void}){
  const [branchMenu,setBranchMenu]=useState(false);
  const [branches,setBranches]=useState<ProjectBranches|null>(null);
  const [branchBusy,setBranchBusy]=useState("");
  const [branchError,setBranchError]=useState("");
  const [changes,setChanges]=useState<ProjectChanges|null>(null);
  const [githubConnected,setGithubConnected]=useState(false);
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
  // меню веток, её нужно закрыть, иначе пункты окажутся под шторкой.
  const toggleBranch=()=>{
    if(branchMenu){setBranchMenu(false);return}
    if(previewOpen)onPreviewToggle();
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
  const repoName=repository?.connected?repositoryName(repository.remoteUrl):"";
  const points=changes?.checkpoints.length??0;
  // Репозиторий проекта и аккаунт GitHub — разные вещи: аккаунт может быть подключён, а
  // репозиторий у проекта ещё не создан. Неотправленные точки относятся именно к репозиторию
  // проекта, иначе шапка обещала бы отправку, которой некуда идти.
  const repoConnected=Boolean(repository?.connected);
  const unpushed=repoConnected?(changes?.checkpoints??[]).filter(item=>!item.pushed).length:0;
  const repoTitle="GitHub"+(!repoConnected
    ?(githubConnected?" подключён, репозиторий проекта ещё не создан":" не подключён — подключить в «Изменениях»")
    :(unpushed>0?" · не отправлено: "+pointsLabel(unpushed):" · репозиторий проекта"));
  const branchTitle=(repoName?"Репозиторий "+repoName+" · ":"")+"ветка "+branch+" · выбрать другую ветку проекта";

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
      {/* Ветка называется прямо в шапке: клик открывает список веток проекта, и выбор сразу
          переключает рабочую область — следующая отправка уйдёт уже в выбранную ветку.
          Стоит у действий, рядом с предпросмотром: на телефоне путь не делит с ней ширину. */}
      <div className="topbar-branch" ref={branchRef}>
        <button className="topbar-branch-button" onClick={toggleBranch} aria-haspopup="menu" aria-expanded={branchMenu} aria-controls="topbar-branch-menu" title={branchTitle} aria-label={(repoName?"Репозиторий "+repoName+", ":"")+"ветка "+branch+": выбрать другую"}>
          <GitBranch size={12}/>
          {/* Имя репозитория рядом с веткой: клик по кнопке открывает ветки, но видно, куда
              именно они уходят — раньше в кнопке была только ветка. */}
          {repoName&&<span className="topbar-branch-repo">{repoName}</span>}
          {repoName&&<span className="topbar-branch-sep" aria-hidden="true">·</span>}
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
