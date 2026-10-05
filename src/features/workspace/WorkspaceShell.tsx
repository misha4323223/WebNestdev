import { useState } from "react";
import { LayoutShell } from "../layout/LayoutShell";
import { PreviewPanel } from "../preview/PreviewPanel";
import { useWorkspace } from "./useWorkspace";
import { WorkspaceNav,type WorkspaceView } from "./WorkspaceNav";
import { WorkspaceContent } from "./WorkspaceContent";
import { SettingsPanel } from "../settings/SettingsPanel";

export function WorkspaceShell(){
  const {projectId,conversationId,projectName}=useWorkspace();
  const [view,setView]=useState<WorkspaceView>("agent");
  const [settingsOpen,setSettingsOpen]=useState(false);

  if(!projectId||!conversationId)return <div className="app-loading">Создаём рабочую область…</div>;

  const createNewProject=()=>{localStorage.removeItem("webnestdev.projectId");localStorage.removeItem("webnestdev.conversationId");localStorage.removeItem("webnestdev.projectName");window.location.reload()};

  return <LayoutShell projectName={projectName} view={view} onView={setView} onNewProject={createNewProject} onDeploy={()=>{setSettingsOpen(false);setView("agent")}} onSettings={()=>setSettingsOpen(true)}>
    <main className="main">
      <div className="workspace-main">
        <WorkspaceNav view={view} onChange={setView}/>
        <WorkspaceContent view={view} projectId={projectId} conversationId={conversationId}/>
      </div>
      <PreviewPanel projectId={projectId}/>
    </main>
  </LayoutShell>;
}
