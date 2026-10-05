import { useState } from "react";
import { PreviewPanel } from "../preview/PreviewPanel";
import { useWorkspace } from "./useWorkspace";
import { WorkspaceNav,type WorkspaceView } from "./WorkspaceNav";
import { WorkspaceContent } from "./WorkspaceContent";

export function WorkspaceShell(){
  const {projectId,conversationId}=useWorkspace();
  const [view,setView]=useState<WorkspaceView>("agent");

  if(!projectId||!conversationId)return <div className="app-loading">Создаём рабочую область…</div>;

  return <main className="workspace-shell">
    <div className="workspace-main">
      <WorkspaceNav view={view} onChange={setView}/>
      <WorkspaceContent view={view} projectId={projectId} conversationId={conversationId}/>
    </div>
    <PreviewPanel projectId={projectId}/>
  </main>;
}
