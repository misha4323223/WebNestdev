import { useEffect,useState } from "react";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { PreviewPanel } from "../preview/PreviewPanel";
import { AgentPanel } from "../agent/AgentPanel";
import { createConversation,createProject } from "../../lib/project-api";

export function WorkspaceShell(){
  const [projectId,setProjectId]=useState(()=>localStorage.getItem("webnestdev.projectId")??"");
  const [conversationId,setConversationId]=useState(()=>localStorage.getItem("webnestdev.conversationId")??"");
  const [view,setView]=useState<"agent"|"files"|"terminal">("agent");

  useEffect(()=>{
    if(projectId&&conversationId)return;
    let cancelled=false;
    (async()=>{
      try{
        const project=await createProject();
        if(cancelled)return;
        const conversation=await createConversation(project.id);
        if(cancelled)return;
        setProjectId(project.id);setConversationId(conversation.id);
        localStorage.setItem("webnestdev.projectId",project.id);
        localStorage.setItem("webnestdev.conversationId",conversation.id);
      }catch{}
    })();
    return()=>{cancelled=true};
  },[projectId,conversationId]);

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
