import type { ReactNode } from "react";
import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import type { WorkspaceView } from "../workspace/WorkspaceNav";

export function LayoutShell({children,projectName,view,onView,onNewProject}:{children:ReactNode;projectName:string;view:WorkspaceView;onView:(view:WorkspaceView)=>void;onNewProject:()=>void}){
  const [sidebarOpen,setSidebarOpen]=useState(false);
  return <div className="app-shell">
    <Topbar projectName={projectName} onMenu={()=>setSidebarOpen(v=>!v)} onNewProject={onNewProject}/>
    <div className="workspace">
      <Sidebar open={sidebarOpen} view={view} onView={v=>{onView(v);setSidebarOpen(false)}} projectName={projectName} onNewProject={onNewProject}/>
      {children}
    </div>
  </div>;
}
