import { useEffect, useState } from "react";
import { LayoutShell } from "../layout/LayoutShell";
import { PreviewPanel } from "../preview/PreviewPanel";
import { SettingsHub } from "../settings/SettingsHub";
import { useWorkspace } from "./useWorkspace";
import { WorkspaceNav,type WorkspaceView } from "./WorkspaceNav";
import { WorkspaceContent } from "./WorkspaceContent";
import { NestLoader } from "../../components/NestLoader";

export function WorkspaceShell({onHome}:{onHome:()=>void}){
  const {projectId,conversationId,projectName,loading,error,retry,openConversation}=useWorkspace();
  const [view,setView]=useState<WorkspaceView>("agent");
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [deployOpen,setDeployOpen]=useState(false);
  // On a phone the preview is a drawer that slides over the workspace, opened from the top bar.
  const [previewOpen,setPreviewOpen]=useState(false);
  const [previewRunning,setPreviewRunning]=useState(false);
  // Every finished run bumps this: the preview panel re-reads the status and reloads the
  // frame, so the app the agent just changed is what the user sees, without a restart.
  const [previewReload,setPreviewReload]=useState(0);

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
  // The model chip in the composer opens the settings overlay on the AI tab.
  const openModelSettings=()=>{try{localStorage.setItem("webnestdev.openProviderTab","1")}catch{};openSettings()};

  return <LayoutShell projectName={projectName} view={view} onView={view=>{setSettingsOpen(false);setDeployOpen(false);setView(view)}} onNewProject={createNewProject} onDeploy={openDeploy} onSettings={openSettings} onHome={onHome} previewOpen={previewOpen} previewRunning={previewRunning} onPreviewToggle={()=>setPreviewOpen(value=>!value)}>
    <main className="main">
      <div className="workspace-main">
        {(settingsOpen||deployOpen)?<div className="workspace-overlay-panel">
          {settingsOpen?<SettingsHub projectId={projectId} projectName={projectName}/>:<section className="settings-panel">
            <div className="panel-title"><div><span className="eyebrow">ПУБЛИКАЦИЯ</span><strong>Публикация проекта</strong></div><button className="ghost-button" onClick={()=>setDeployOpen(false)}>Закрыть</button></div>
            <div className="settings-body"><p>Модуль публикации подключим к выбранному облаку, когда настроим окружение.</p><button className="send-button" onClick={()=>setDeployOpen(false)}>Понятно</button></div>
          </section>}
        </div>:<><WorkspaceNav view={view} onChange={setView}/><WorkspaceContent view={view} projectId={projectId} conversationId={conversationId} onOpenConversation={openConversation} onRunFinished={()=>setPreviewReload(value=>value+1)} onOpenModelSettings={openModelSettings} onOpenAccountSettings={openSettings}/></>}
      </div>
      <PreviewPanel projectId={projectId} reloadToken={previewReload} open={previewOpen} onClose={()=>setPreviewOpen(false)} onRunningChange={setPreviewRunning}/>
    </main>
  </LayoutShell>;
}
