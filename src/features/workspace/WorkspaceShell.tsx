import { useCallback, useEffect, useState } from "react";
import { LayoutShell } from "../layout/LayoutShell";
import { PreviewPanel } from "../preview/PreviewPanel";
import { SettingsHub } from "../settings/SettingsHub";
import { useWorkspace } from "./useWorkspace";
import { WorkspaceNav,type WorkspaceView } from "./WorkspaceNav";
import { WorkspaceContent } from "./WorkspaceContent";
import { ChatSessionsModal, useChatSessions } from "../agent/ChatSessions";
import { NestLoader } from "../../components/NestLoader";

export function WorkspaceShell({onHome,onAgentState}:{onHome:()=>void;onAgentState?:(state:{running:boolean;projectName:string}|null)=>void}){
  const {projectId,conversationId,projectName,loading,error,retry,openConversation}=useWorkspace();
  const [view,setView]=useState<WorkspaceView>("agent");
  // Рабочая область остаётся смонтированной, когда пользователь уходит на главную, поэтому
  // запуск продолжается; состояние поднимается наверх, чтобы главная сказала, над чем идёт работа.
  const [agentRunning,setAgentRunning]=useState(false);
  const reportAgentState=useCallback((running:boolean)=>setAgentRunning(running),[]);
  const [settingsOpen,setSettingsOpen]=useState(false);
  // Список чатов принадлежит рабочей области: кнопка в строке вкладок открывает его
  // и из «Агента», и из «Файлов», а не только из шапки чата.
  const [sessionsOpen,setSessionsOpen]=useState(false);
  const {sessions,sessionsError,reload:sessionsReload}=useChatSessions(projectId,conversationId);
  // Incremented when the sidebar asks for a specific settings tab while the overlay is already
  // open: the hub reads its one-shot tab flag on mount, so it has to be remounted to react.
  const [settingsKey,setSettingsKey]=useState(0);
  const [deployOpen,setDeployOpen]=useState(false);
  // On a phone the preview is a drawer that slides over the workspace, opened from the top bar.
  const [previewOpen,setPreviewOpen]=useState(false);
  const [previewRunning,setPreviewRunning]=useState(false);
  // Every finished run bumps this: the preview panel re-reads the status and reloads the
  // frame, so the app the agent just changed is what the user sees, without a restart.
  const [previewReload,setPreviewReload]=useState(0);

  useEffect(()=>{onAgentState?.(agentRunning?{running:true,projectName}:null)},[agentRunning,projectName,onAgentState]);
  // Пока рабочая область жива, главная не имеет своего запуска: уходя, она снимает свой статус.
  useEffect(()=>()=>{onAgentState?.(null)},[onAgentState]);

  // A GitHub OAuth return asks for the settings overlay with the Integrations tab.
  // Read in an effect: state initializers run twice under StrictMode.
  useEffect(()=>{
    if(!localStorage.getItem("webnestdev.openSettings"))return;
    localStorage.removeItem("webnestdev.openSettings");
    setDeployOpen(false);
    setSettingsOpen(true);
  },[]);

  if(loading)return <div className="app-loading"><NestLoader size={46} label="Подключаем рабочую область"/><span>Подключаем рабочую область…</span></div>;
  if(error)return <div className="app-loading"><strong>WebNestdev API недоступен</strong><span>{error}</span><button className="ghost-button" onClick={()=>void retry()}>Повторить</button></div>;
  if(!projectId||!conversationId)return <div className="app-loading">Рабочая область не создана.</div>;

  const createNewProject=()=>{localStorage.removeItem("webnestdev.projectId");localStorage.removeItem("webnestdev.conversationId");localStorage.removeItem("webnestdev.projectName");window.location.reload()};
  // The overlays replace the workspace, so the drawer is closed instead of floating above them.
  const openDeploy=()=>{setSettingsOpen(false);setPreviewOpen(false);setDeployOpen(true)};
  const openSettings=()=>{setDeployOpen(false);setPreviewOpen(false);setSettingsOpen(true)};
  // The sidebar opens the same settings overlay, but on the project secrets tab.
  const openSecrets=()=>{
    try{localStorage.setItem("webnestdev.openSecretsTab","1")}catch{}
    if(settingsOpen)setSettingsKey(value=>value+1);
    else openSettings();
  };
  // The model chip in the composer opens the settings overlay on the AI tab.
  const openModelSettings=()=>{try{localStorage.setItem("webnestdev.openProviderTab","1")}catch{};openSettings()};

  return <LayoutShell projectName={projectName} view={view} onView={view=>{setSettingsOpen(false);setDeployOpen(false);setView(view)}} onNewProject={createNewProject} onDeploy={openDeploy} onSettings={openSettings} onSecrets={openSecrets} onHome={onHome} previewOpen={previewOpen} previewRunning={previewRunning} onPreviewToggle={()=>setPreviewOpen(value=>!value)} sidebarHidden={settingsOpen||deployOpen}>
    <main className="main">
      <div className="workspace-main">
        {(settingsOpen||deployOpen)?<div className="workspace-overlay-panel">
          {settingsOpen?<SettingsHub key={settingsKey} projectId={projectId} projectName={projectName} onClose={()=>setSettingsOpen(false)}/>:<section className="settings-panel">
            <div className="panel-title"><div><span className="eyebrow">ПУБЛИКАЦИЯ</span><strong>Публикация проекта</strong></div><button className="ghost-button" onClick={()=>setDeployOpen(false)}>Закрыть</button></div>
            <div className="settings-body"><p>Модуль публикации подключим к выбранному облаку, когда настроим окружение.</p><button className="send-button" onClick={()=>setDeployOpen(false)}>Понятно</button></div>
          </section>}
        </div>:<><WorkspaceNav view={view} onChange={setView} onSessions={()=>setSessionsOpen(true)} sessionCount={sessions?.length}/><WorkspaceContent view={view} projectId={projectId} projectName={projectName} conversationId={conversationId} onRunFinished={()=>{setPreviewReload(value=>value+1);void sessionsReload()}} onOpenModelSettings={openModelSettings} onOpenAccountSettings={openSettings} onRunningChange={reportAgentState} onOpenChanges={()=>{setSettingsOpen(false);setDeployOpen(false);setView("changes")}}/></>}
      </div>
      <PreviewPanel projectId={projectId} reloadToken={previewReload} open={previewOpen} onClose={()=>setPreviewOpen(false)} onRunningChange={setPreviewRunning}/>
      <ChatSessionsModal
        open={sessionsOpen}
        projectId={projectId}
        conversationId={conversationId}
        sessions={sessions}
        sessionsError={sessionsError}
        reload={sessionsReload}
        onClose={()=>setSessionsOpen(false)}
        onOpenConversation={openConversation}
      />
    </main>
  </LayoutShell>;
}
