import type { ReactNode } from "react";
import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import type { WorkspaceView } from "../workspace/WorkspaceNav";

export function LayoutShell({children,projectName,view,onView,onNewProject,onDeploy,onSettings,onHome}:{children:ReactNode;projectName:string;view:WorkspaceView;onView:(view:WorkspaceView)=>void;onNewProject:()=>void;onDeploy:()=>void;onSettings:()=>void;onHome:()=>void}){
  const [sidebarOpen,setSidebarOpen]=useState(false);
  return <div className="app-shell">
    <Topbar projectName={projectName} onMenu={()=>setSidebarOpen(v=>!v)} onNewProject={onNewProject} onHome={onHome} onPlan={onSettings}/>
    <div className="workspace">
      <Sidebar open={sidebarOpen} view={view} onView={v=>{onView(v);setSidebarOpen(false)}} projectName={projectName} onNewProject={onNewProject} onDeploy={onDeploy} onSettings={onSettings} onHome={()=>{onHome();setSidebarOpen(false)}}/>
      {children}
    </div>
  </div>;
}
