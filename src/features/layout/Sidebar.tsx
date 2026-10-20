import { Bot,FolderGit2,History,Home,KeyRound,Settings,Terminal } from "lucide-react";
import type { WorkspaceView } from "../workspace/WorkspaceNav";
import { SidebarBanner } from "./SidebarBanner";

/**
 * Колонка рабочей области. Создание проекта живёт только на главной странице, а публикация пока
 * спрятана: две кнопки, которые ничего не добавляли к текущей задаче, уводили внимание от работы.
 */
export function Sidebar({open,view,onView,projectName,onSettings,onSecrets,onHome}:{open:boolean;view:WorkspaceView;onView:(view:WorkspaceView)=>void;projectName:string;onSettings:()=>void;onSecrets:()=>void;onHome:()=>void}){
  return <aside className={"sidebar"+(open?" open":"")}>
    <div className="sidebar-section"><button className="nav-item" onClick={onHome}><Home size={14}/> На главную</button></div>
    <div className="sidebar-section"><div className="section-label">РАБОЧАЯ ОБЛАСТЬ</div>
      <button className={"nav-item "+(view==="agent"?"active":"")} onClick={()=>onView("agent")}><Bot size={14}/> Агент</button>
      <button className={"nav-item "+(view==="files"?"active":"")} onClick={()=>onView("files")}><FolderGit2 size={14}/> Файлы</button>
      <button className={"nav-item "+(view==="changes"?"active":"")} onClick={()=>onView("changes")}><History size={14}/> Изменения</button>
      <button className={"nav-item "+(view==="terminal"?"active":"")} onClick={()=>onView("terminal")}><Terminal size={14}/> Терминал</button>
      <button className="nav-item" onClick={onSecrets}><KeyRound size={14}/> Секреты</button>
    </div>
    <div className="sidebar-section"><div className="section-label">ПРОЕКТ</div><div className="project-row"><span className="status-dot"/>{projectName}</div></div>
    <div className="sidebar-footer">
      <SidebarBanner/>
      <button className="nav-item" onClick={onSettings}><Settings size={14}/> Настройки</button>
    </div>
  </aside>;
}
