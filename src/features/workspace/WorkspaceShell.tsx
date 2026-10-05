import { useState } from "react";
import { LayoutShell } from "../layout/LayoutShell";
import { PreviewPanel } from "../preview/PreviewPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { useWorkspace } from "./useWorkspace";
import { WorkspaceNav,type WorkspaceView } from "./WorkspaceNav";
import { WorkspaceContent } from "./WorkspaceContent";

export function WorkspaceShell(){
  const {projectId,conversationId,projectName}=useWorkspace();
  const [view,setView]=useState<WorkspaceView>("agent");
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [deployOpen,setDeployOpen]=useState(false);

  if(!projectId||!conversationId)return <div className="app-loading">Создаём рабочую область…</div>;

  const createNewProject=()=>{localStorage.removeItem("webnestdev.projectId");localStorage.removeItem("webnestdev.conversationId");localStorage.removeItem("webnestdev.projectName");window.location.reload()};
  const openDeploy=()=>{setSettingsOpen(false);setDeployOpen(true)};
  const openSettings=()=>{setDeployOpen(false);setSettingsOpen(true)};

  return <LayoutShell projectName={projectName} view={view} onView={view=>{setSettingsOpen(false);setDeployOpen(false);setView(view)}} onNewProject={createNewProject} onDeploy={openDeploy} onSettings={openSettings}>
    <main className="main">
      <div className="workspace-main">
        {(settingsOpen||deployOpen)?<div className="workspace-overlay-panel">
          {settingsOpen?<SettingsPanel projectName={projectName} onClose={()=>setSettingsOpen(false)}/>:<section className="settings-panel">
            <div className="panel-title"><div><span className="eyebrow">DEPLOY</span><strong>Публикация проекта</strong></div><button className="ghost-button" onClick={()=>setDeployOpen(false)}>Закрыть</button></div>
            <div className="settings-body"><p>Deployment-модуль подключим к выбранному провайдеру после настройки окружения.</p><button className="send-button" onClick={()=>setDeployOpen(false)}>Понятно</button></div>
          </section>}
        </div>:<><WorkspaceNav view={view} onChange={setView}/><WorkspaceContent view={view} projectId={projectId} conversationId={conversationId}/></>}
      </div>
      <PreviewPanel projectId={projectId}/>
    </main>
  </LayoutShell>;
}
