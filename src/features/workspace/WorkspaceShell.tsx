import { useState } from "react";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { PreviewPanel } from "../preview/PreviewPanel";
import { AgentPanel } from "../agent/AgentPanel";
import { useWorkspace } from "./useWorkspace";

export function WorkspaceShell(){
  const {projectId,conversationId}=useWorkspace();
  const [view,setView]=useState<"agent"|"files"|"terminal">("agent");

  if(!projectId||!conversationId)return <div className="app-loading">Создаём рабочую область…</div>;

  return <main className="workspace-shell">
    <div className="workspace-main">
      <nav className="workspace-tabs">
        <button className={view==="agent"?"active":""} onClick={()=>setView("agent")}>Agent</button>
        <button className={view==="files"?"active":""} onClick={()=>setView("files")}>Files</button>
        <button className={view==="terminal"?"active":""} onClick={()=>setView("terminal")}>Terminal</button>
      </nav>
      {view==="agent"&&<AgentPanel projectId={projectId} conversationId={conversationId} onChanged={()=>{}}/>}
      {view==="files"&&<FilePanel projectId={projectId}/>}
      {view==="terminal"&&<TerminalPanel projectId={projectId}/>}
    </div>
    <PreviewPanel projectId={projectId}/>
  </main>;
}
