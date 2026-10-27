import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sidebar, type SidebarChats } from "./Sidebar";
import { Topbar } from "./Topbar";

/** `sidebarHidden` убирает колонку там, где она мешает содержимому: настройки занимают всю
 *  ширину, а телефонная шторка закрывается, чтобы не лежать поверх них. */
export function LayoutShell({children,projectId,projectName,onRenameProject,onSettings,onSecrets,onDeploy,onHome,onOpenChanges,agentRunning,previewOpen,previewRunning,onPreviewToggle,onRepositoryChanged,sidebarHidden,chats}:{children:ReactNode;projectId:string;projectName:string;onRenameProject:(name:string)=>Promise<unknown>;onSettings:()=>void;onSecrets:()=>void;onDeploy:()=>void;onHome:()=>void;onOpenChanges:()=>void;agentRunning:boolean;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void;onRepositoryChanged?:()=>void;sidebarHidden?:boolean;chats:SidebarChats}){
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

  // Выбор чата на телефоне закрывает шторку: дальше человек читает переписку, а не список.
  const sidebarChats:SidebarChats={
    ...chats,
    onOpen:id=>{chats.onOpen(id);setSidebarOpen(false)},
    onNew:async()=>{try{await chats.onNew()}finally{setSidebarOpen(false)}},
  };

  return <div className={"app-shell"+(sidebarHidden?" sidebar-hidden":"")}>
    <Topbar projectId={projectId} projectName={projectName} onRenameProject={onRenameProject} running={agentRunning} sidebarOpen={sidebarOpen} onMenu={()=>setSidebarOpen(v=>!v)} onHome={onHome} onOpenChanges={onOpenChanges} onSettings={onSettings} onSecrets={onSecrets} onDeploy={onDeploy} previewOpen={previewOpen} previewRunning={previewRunning} onPreviewToggle={onPreviewToggle} onRepositoryChanged={onRepositoryChanged}/>
    <div className="workspace">
      <div className={"sidebar-backdrop"+(sidebarOpen?" open":"")} onClick={()=>setSidebarOpen(false)} aria-hidden="true"/>
      <Sidebar open={sidebarOpen} chats={sidebarChats} onPlan={onSettings}/>
      {children}
    </div>
  </div>;
}
