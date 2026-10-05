import { Bot,FolderGit2,Terminal } from "lucide-react";

export type WorkspaceView="agent"|"files"|"terminal";

export function WorkspaceNav({view,onChange}:{view:WorkspaceView;onChange:(view:WorkspaceView)=>void}){
  return <nav className="workspace-tabs">
    <button className={view==="agent"?"active":""} onClick={()=>onChange("agent")}><Bot size={15}/> Agent</button>
    <button className={view==="files"?"active":""} onClick={()=>onChange("files")}><FolderGit2 size={15}/> Files</button>
    <button className={view==="terminal"?"active":""} onClick={()=>onChange("terminal")}><Terminal size={15}/> Terminal</button>
  </nav>;
}
