import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { LayoutShell } from "../layout/LayoutShell";
import { PreviewPanel } from "../preview/PreviewPanel";
import { conversationMemoryKey, useWorkspace } from "./useWorkspace";
import { WorkspaceNav,type WorkspaceView } from "./WorkspaceNav";
import { WorkspaceContent } from "./WorkspaceContent";
import { useProjectWake } from "./useProjectWake";
import { ProjectWakeCard } from "./ProjectWakeCard";
import { useChatSessions } from "../agent/ChatSessions";
import { composeAgentPrompt } from "../../lib/agent-compose";
import { NestLoader } from "../../components/NestLoader";
import { createConversation, deleteConversation, type ConversationSummary } from "../../lib/project-api";

// Настройки и мастер развёртывания открываются поверх рабочей области и не нужны при каждом
// входе в проект. Их код приезжает только по нажатию, а до этого рабочая область остаётся легче.
const SettingsHub = lazy(() => import("../settings/SettingsHub").then(module => ({ default: module.SettingsHub })));
const DeploymentWizard = lazy(() => import("../deployment/DeploymentWizard").then(module => ({ default: module.DeploymentWizard })));

export function WorkspaceShell({onHome,onAgentState,active=true}:{onHome:()=>void;onAgentState?:(state:{running:boolean;projectName:string}|null)=>void;active?:boolean}){
  const {projectId,conversationId,projectName,loading,error,retry,openConversation,renameCurrentProject}=useWorkspace();
  const [view,setView]=useState<WorkspaceView>("agent");
  // Рабочая область остаётся смонтированной, когда пользователь уходит на главную, поэтому
  // запуск продолжается; состояние поднимается наверх, чтобы главная сказала, над чем идёт работа.
  const [agentRunning,setAgentRunning]=useState(false);
  const reportAgentState=useCallback((running:boolean)=>setAgentRunning(running),[]);
  const [settingsOpen,setSettingsOpen]=useState(false);
  // Квиз развёртывания — отдельное окно поверх рабочей области: собрав параметры, оно
  // закрывается и передаёт агенту готовый бриф, а не оставляет пользователя в форме.
  const [deployOpen,setDeployOpen]=useState(false);
  // Переписка живёт в AgentPanel, а кнопка «вниз» — в строке вкладок: сигнал идёт вверх числом,
  // а панель сообщает наверх, осталось ли что-то ниже видимой области.
  const [scrollSignal,setScrollSignal]=useState(0);
  const [chatAtEnd,setChatAtEnd]=useState(true);
  const scrollChatToBottom=useCallback(()=>setScrollSignal(value=>value+1),[]);
  const reportChatEnd=useCallback((atEnd:boolean)=>setChatAtEnd(atEnd),[]);
  // Список чатов принадлежит рабочей области, а показывает его колонка слева: она видна и в
  // «Агенте», и в «Файлах», поэтому вкладка остаётся там, где человек работает.
  const {sessions,sessionsError,reload:sessionsReload}=useChatSessions(projectId,conversationId);
  /** Новый чат проекта: пустая сессия сразу открывается, колонка перечитывает список. */
  const newChat=useCallback(async()=>{
    const created=await createConversation(projectId);
    openConversation(created.id);
    await sessionsReload();
  },[projectId,openConversation,sessionsReload]);
  /**
   * Удаление чата не трогает проект. Если удалён открытый чат, рабочая область переходит к
   * следующему, а когда других нет — сразу создаёт новый, иначе панель осталась бы с
   * идентификатором несуществующей сессии.
   */
  const deleteChat=useCallback(async(session:ConversationSummary)=>{
    await deleteConversation(session.id);
    try{
      localStorage.removeItem("webnestdev.pendingStart."+session.id);
      if(session.id===conversationId){
        localStorage.removeItem("webnestdev.conversationId");
        localStorage.removeItem(conversationMemoryKey(projectId));
      }
    }catch{}
    if(session.id===conversationId){
      const remaining=(sessions??[]).filter(item=>item.id!==session.id);
      openConversation(remaining[0]?.id??(await createConversation(projectId)).id);
    }
    await sessionsReload();
  },[conversationId,projectId,sessions,openConversation,sessionsReload]);
  // Incremented when the sidebar asks for a specific settings tab while the overlay is already
  // open: the hub reads its one-shot tab flag on mount, so it has to be remounted to react.
  const [settingsKey,setSettingsKey]=useState(0);

  // On a phone the preview is a drawer that slides over the workspace, opened from the top bar.
  const [previewOpen,setPreviewOpen]=useState(false);
  const [previewRunning,setPreviewRunning]=useState(false);
  // Every finished run bumps this: the preview panel re-reads the status and reloads the
  // frame, so the app the agent just changed is what the user sees, without a restart.
  const [previewReload,setPreviewReload]=useState(0);
  // Каждый законченный запуск может переписать TASKS.md: вкладка задач перечитывает файл,
  // когда её откроют, и не показывает список прошлого хода.
  const [taskReload,setTaskReload]=useState(0);
  // Проект после долгого простоя лежит в бакете: пока файлы едут обратно, рабочая область
  // показывает прогресс, а не пустые списки и 409 от каждого запроса. Готовность поднимает
  // счётчик предпросмотра — он перечитывает статус и кадр уже на живой папке.
  const wakeReady=useCallback(()=>setPreviewReload(value=>value+1),[]);
  const wake=useProjectWake(projectId,wakeReady);
  // Вкладка могла простоять открытой всю ночь: при возврате проверяем, не уехал ли проект в
  // холодный ярус, и если да — показываем пробуждение вместо ошибок в панелях.
  const recheckWake=wake.recheck;
  const waking=wake.phase==="waking"||wake.phase==="failed";
  // Смена вкладки — ещё один момент, когда проект мог уехать в архив, пока панель стояла
  // открытой. Живой проект отвечает одним чтением отметки, поэтому проверка дешёвая.
  const firstViewCheck=useRef(true);
  useEffect(()=>{
    if(firstViewCheck.current){firstViewCheck.current=false;return}
    if(!waking)void recheckWake();
  },[view,waking,recheckWake]);
  // Главная и рабочая область живут одновременно: возврат из главной не перемонтирует панель,
  // поэтому это отдельный повод проверить, не уехал ли проект в архив, пока его не было на экране.
  const firstActive=useRef(true);
  useEffect(()=>{
    if(firstActive.current){firstActive.current=false;return}
    if(active)void recheckWake();
  },[active,recheckWake]);
  useEffect(()=>{
    const onVisible=()=>{if(document.visibilityState==="visible")void recheckWake()};
    window.addEventListener("focus",onVisible);
    document.addEventListener("visibilitychange",onVisible);
    return ()=>{
      window.removeEventListener("focus",onVisible);
      document.removeEventListener("visibilitychange",onVisible);
    };
  },[recheckWake]);

  useEffect(()=>{onAgentState?.(agentRunning?{running:true,projectName}:null)},[agentRunning,projectName,onAgentState]);
  // Пока рабочая область жива, главная не имеет своего запуска: уходя, она снимает свой статус.
  useEffect(()=>()=>{onAgentState?.(null)},[onAgentState]);

  // A GitHub OAuth return asks for the settings overlay with the Integrations tab.
  // Read in an effect: state initializers run twice under StrictMode.
  useEffect(()=>{
    if(!localStorage.getItem("webnestdev.openSettings"))return;
    localStorage.removeItem("webnestdev.openSettings");
    setSettingsOpen(true);
  },[]);

  if(loading)return <div className="app-loading"><NestLoader size={46} label="Подключаем рабочую область"/><span>Подключаем рабочую область…</span></div>;
  if(error)return <div className="app-loading"><strong>NestDev API недоступен</strong><span>{error}</span><button className="ghost-button" onClick={()=>void retry()}>Повторить</button></div>;
  if(!projectId||!conversationId)return <div className="app-loading">Рабочая область не создана.</div>;

  // Облатка заменяет рабочую область, поэтому шторка закрывается, а не висит поверх неё.
  const openSettings=()=>{setPreviewOpen(false);setSettingsOpen(true)};
  // The sidebar opens the same settings overlay, but on the project secrets tab.
  const openSecrets=()=>{
    try{localStorage.setItem("webnestdev.openSecretsTab","1")}catch{}
    if(settingsOpen)setSettingsKey(value=>value+1);
    else openSettings();
  };
  // The model chip in the composer opens the settings overlay on the AI tab.
  const openModelSettings=()=>{try{localStorage.setItem("webnestdev.openProviderTab","1")}catch{};openSettings()};

  // Ветка и история в шапке открывают тот же раздел, поэтому сначала закрывается облатка настроек:
  // иначе «Изменения» монтировались бы под ней и клик выглядел бы как пустой.
  const openChanges=()=>{setSettingsOpen(false);setPreviewOpen(false);setView("changes")};

  // Пока проект просыпается, панели не монтируются: файлы, терминал и предпросмотр всё равно
  // получили бы 409, а панель агента открыла бы сокет на полупустой каталог.
  return <LayoutShell projectId={projectId} projectName={projectName} onRenameProject={renameCurrentProject} onSettings={openSettings} onSecrets={openSecrets} onDeploy={()=>setDeployOpen(true)} onHome={onHome} onOpenChanges={openChanges} agentRunning={agentRunning} previewOpen={previewOpen} previewRunning={previewRunning} onPreviewToggle={()=>setPreviewOpen(value=>!value)} onRepositoryChanged={()=>setPreviewReload(value=>value+1)} sidebarHidden={settingsOpen} chats={{projectId,activeId:conversationId,sessions,error:sessionsError,onNew:newChat,onOpen:openConversation,onDelete:deleteChat}}>
    <main className="main">
      <div className="workspace-main">
        {waking?<ProjectWakeCard progress={wake.progress} error={wake.error} onRetry={wake.retry}/>:settingsOpen?<div className="workspace-overlay-panel">
          <Suspense fallback={<div className="app-loading"><NestLoader size={42} label="Загружаем настройки"/></div>}>
            <SettingsHub key={settingsKey} projectId={projectId} projectName={projectName} onClose={()=>setSettingsOpen(false)}/>
          </Suspense>
        </div>:<><WorkspaceNav view={view} onChange={setView} onSecrets={openSecrets}/><WorkspaceContent view={view} projectId={projectId} projectName={projectName} conversationId={conversationId} onRunFinished={()=>{setPreviewReload(value=>value+1);setTaskReload(value=>value+1);void sessionsReload()}} onFileSaved={()=>setPreviewReload(value=>value+1)} taskReload={taskReload} onOpenModelSettings={openModelSettings} onOpenAccountSettings={openSettings} onRunningChange={reportAgentState} onOpenChanges={()=>{setSettingsOpen(false);setView("changes")}} scrollSignal={scrollSignal} onChatEndChange={reportChatEnd} onScrollBottom={scrollChatToBottom} showScroll={view==="agent"&&!chatAtEnd} writing={view==="agent"&&!chatAtEnd&&agentRunning}/></>}
      </div>
      {!waking&&<PreviewPanel projectId={projectId} reloadToken={previewReload} open={previewOpen} onClose={()=>setPreviewOpen(false)} onRunningChange={setPreviewRunning}/>}
      {deployOpen&&<Suspense fallback={<div className="app-loading"><NestLoader size={42} label="Загружаем мастер развёртывания"/></div>}>
        <DeploymentWizard
          projectId={projectId}
          onClose={()=>setDeployOpen(false)}
          onStarted={brief=>{setDeployOpen(false);setSettingsOpen(false);setPreviewOpen(false);setView("agent");composeAgentPrompt(brief)}}
        />
      </Suspense>}
    </main>
  </LayoutShell>;
}
