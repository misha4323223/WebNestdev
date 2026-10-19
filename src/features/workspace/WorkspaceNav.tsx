import { Bot,FolderGit2,History,MessagesSquare,Terminal } from "lucide-react";

export type WorkspaceView="agent"|"files"|"changes"|"terminal";

export function WorkspaceNav({view,onChange,onSessions,sessionCount}:{view:WorkspaceView;onChange:(view:WorkspaceView)=>void;onSessions:()=>void;sessionCount?:number}){
  return <nav className="workspace-tabs">
    <button className={view==="agent"?"active":""} onClick={()=>onChange("agent")}><Bot size={15}/> Агент</button>
    <button className={view==="files"?"active":""} onClick={()=>onChange("files")}><FolderGit2 size={15}/> Файлы</button>
    <button className={view==="changes"?"active":""} onClick={()=>onChange("changes")}><History size={15}/> Изменения</button>
    <button className={view==="terminal"?"active":""} onClick={()=>onChange("terminal")}><Terminal size={15}/> Терминал</button>
    {/* История переписки — рядом с вкладками, а не отдельной шапкой над чатом. */}
    <button className="workspace-tabs-chats" onClick={onSessions} title="Сохранённые чаты проекта — вернуться к любому" aria-label="Чаты проекта">
      <MessagesSquare size={14}/>
      <span>Чаты{sessionCount&&sessionCount>1?" · "+sessionCount:""}</span>
    </button>
  </nav>;
}
