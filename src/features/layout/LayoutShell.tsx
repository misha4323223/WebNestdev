import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import type { WorkspaceView } from "../workspace/WorkspaceNav";

/** `sidebarHidden` убирает колонку там, где она мешает содержимому: настройки занимают всю
 *  ширину, а телефонная шторка закрывается, чтобы не лежать поверх них. */
export function LayoutShell({children,projectId,projectName,view,onView,onSettings,onSecrets,onHome,onOpenChanges,agentRunning,previewOpen,previewRunning,onPreviewToggle,onRepositoryChanged,sidebarHidden}:{children:ReactNode;projectId:string;projectName:string;view:WorkspaceView;onView:(view:WorkspaceView)=>void;onSettings:()=>void;onSecrets:()=>void;onHome:()=>void;onOpenChanges:()=>void;agentRunning:boolean;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void;onRepositoryChanged?:()=>void;sidebarHidden?:boolean}){
  const [sidebarOpen,setSidebarOpen]=useState(false);
  // Ушли в настройки — шторка на телефоне закрывается вместе с переходом.
  useEffect(()=>{if(sidebarHidden)setSidebarOpen(false)},[sidebarHidden]);

  // Шторка закрывается нажатием в любом месте вне её — по переписке, по панели предпросмотра,
  // по самой подложке — и по Escape. Раньше единственным способом убрать её была та же кнопка
  // меню в шапке: на телефоне она оказывалась под пальцем уже после перехода.
  useEffect(()=>{
    if(!sidebarOpen)return;
    const onPointer=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target?.closest(".sidebar")||target?.closest(".menu-toggle"))return;
      setSidebarOpen(false);
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")setSidebarOpen(false)};
    document.addEventListener("pointerdown",onPointer,true);
    window.addEventListener("keydown",onKey);
    return ()=>{
      document.removeEventListener("pointerdown",onPointer,true);
      window.removeEventListener("keydown",onKey);
    };
  },[sidebarOpen]);

  return <div className={"app-shell"+(sidebarHidden?" sidebar-hidden":"")}>
    <Topbar projectId={projectId} projectName={projectName} running={agentRunning} sidebarOpen={sidebarOpen} onMenu={()=>setSidebarOpen(v=>!v)} onHome={onHome} onOpenChanges={onOpenChanges} onSettings={onSettings} onSecrets={onSecrets} previewOpen={previewOpen} previewRunning={previewRunning} onPreviewToggle={onPreviewToggle} onRepositoryChanged={onRepositoryChanged}/>
    <div className="workspace">
      <div className={"sidebar-backdrop"+(sidebarOpen?" open":"")} onClick={()=>setSidebarOpen(false)} aria-hidden="true"/>
      <Sidebar open={sidebarOpen} view={view} onView={v=>{onView(v);setSidebarOpen(false)}} onPlan={onSettings} onHome={()=>{onHome();setSidebarOpen(false)}}/>
      {children}
    </div>
  </div>;
}
