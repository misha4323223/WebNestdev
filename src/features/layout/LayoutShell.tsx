import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import type { WorkspaceView } from "../workspace/WorkspaceNav";

/** `sidebarHidden` убирает колонку там, где она мешает содержимому: настройки и публикация
 *  занимают всю ширину, а телефонная шторка закрывается, чтобы не лежать поверх них. */
export function LayoutShell({children,projectName,view,onView,onNewProject,onDeploy,onSettings,onSecrets,onHome,previewOpen,previewRunning,onPreviewToggle,sidebarHidden}:{children:ReactNode;projectName:string;view:WorkspaceView;onView:(view:WorkspaceView)=>void;onNewProject:()=>void;onDeploy:()=>void;onSettings:()=>void;onSecrets:()=>void;onHome:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void;sidebarHidden?:boolean}){
  const [sidebarOpen,setSidebarOpen]=useState(false);
  // Ушли в настройки — шторка на телефоне закрывается вместе с переходом.
  useEffect(()=>{if(sidebarHidden)setSidebarOpen(false)},[sidebarHidden]);
  return <div className={"app-shell"+(sidebarHidden?" sidebar-hidden":"")}>
    <Topbar projectName={projectName} onMenu={()=>setSidebarOpen(v=>!v)} onNewProject={onNewProject} onHome={onHome} onPlan={onSettings} previewOpen={previewOpen} previewRunning={previewRunning} onPreviewToggle={onPreviewToggle}/>
    <div className="workspace">
      <Sidebar open={sidebarOpen} view={view} onView={v=>{onView(v);setSidebarOpen(false)}} projectName={projectName} onNewProject={onNewProject} onDeploy={onDeploy} onSettings={onSettings} onSecrets={()=>{onSecrets();setSidebarOpen(false)}} onHome={()=>{onHome();setSidebarOpen(false)}}/>
      {children}
    </div>
  </div>;
}
