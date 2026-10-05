import { Bot,FolderGit2,LayoutDashboard,Plus,Settings,Sparkles,Terminal } from "lucide-react";
import type { WorkspaceView } from "../workspace/WorkspaceNav";

export function Sidebar({open,view,onView,projectName,onNewProject}:{open:boolean;view:WorkspaceView;onView:(view:WorkspaceView)=>void;projectName:string;onNewProject:()=>void}){
  return <aside className={"sidebar"+(open?" open":"")}>
    <div className="sidebar-head"><button className="new-project" onClick={onNewProject}><Plus size={14}/> Новый проект</button></div>
    <div className="sidebar-section"><div className="section-label">WORKSPACE</div>
      <button className={"nav-item "+(view==="agent"?"active":"")} onClick={()=>onView("agent")}><Bot size={14}/> Agent</button>
      <button className={"nav-item "+(view==="files"?"active":"")} onClick={()=>onView("files")}><FolderGit2 size={14}/> Files</button>
      <button className={"nav-item "+(view==="terminal"?"active":"")} onClick={()=>onView("terminal")}><Terminal size={14}/> Terminal</button>
      <button className="nav-item"><LayoutDashboard size={14}/> Deploy</button>
    </div>
    <div className="sidebar-section"><div className="section-label">PROJECT</div><div className="project-row"><span className="status-dot"/>{projectName}</div></div>
    <div className="sidebar-footer">
      <div className="sponsor-label">SUPPORTED BY</div>
      <div className="sponsor-card"><div className="sponsor-logo"><Sparkles size={13}/></div><div><strong>WebNestdev Sponsor</strong><span>Поддержка бесплатного режима</span></div></div>
      <button className="nav-item"><Settings size={14}/> Settings</button>
    </div>
  </aside>;
}
