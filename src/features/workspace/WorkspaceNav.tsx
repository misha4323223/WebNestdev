import { ArrowDownToLine,Bot,FolderGit2,GitBranch,ListTodo,MessagesSquare,Terminal } from "lucide-react";

export type WorkspaceView="agent"|"tasks"|"files"|"changes"|"terminal";

/**
 * Строка вкладок рабочей области. Кнопка «вниз» живёт здесь же: переписка открывается с начала
 * диалога, и вернуться к последнему сообщению нужно из того места, где видно вкладки, а не искать
 * точку у края чата. Показывается только когда ниже есть непрочитанное.
 */
export function WorkspaceNav({view,onChange,onSessions,sessionCount,onScrollBottom,showScroll,writing,onSecrets}:{view:WorkspaceView;onChange:(view:WorkspaceView)=>void;onSessions:()=>void;sessionCount?:number;onScrollBottom?:()=>void;showScroll?:boolean;writing?:boolean;onSecrets?:()=>void}){
  return <nav className="workspace-tabs">
    <button className={view==="agent"?"active":""} onClick={()=>onChange("agent")} title="Чат с агентом"><Bot size={15}/> Агент</button>
    <button className={view==="tasks"?"active":""} onClick={()=>onChange("tasks")} title="Задачи проекта: список дел, который агент читает по запросу"><ListTodo size={15}/> Задачи</button>
    <button className={view==="files"?"active":""} onClick={()=>onChange("files")} title="Файлы проекта и редактор"><FolderGit2 size={15}/> Файлы</button>
    <button className={view==="changes"?"active":""} onClick={()=>onChange("changes")} title="Git: рабочие изменения, коммиты, ветки и история"><GitBranch size={15}/> Git</button>
    <button className={view==="terminal"?"active":""} onClick={()=>onChange("terminal")} title="Команды в папке проекта"><Terminal size={15}/> Терминал</button>
    {/* Ключи — текстовая кнопка на месте ракеты: действие, а не раздел, и подпись понятнее значка. */}
    {onSecrets&&<button className="workspace-tabs-keys" onClick={onSecrets} title="Секреты проекта: ключи и переменные окружения" aria-label="Ключи проекта">Ключи</button>}
    {/* История переписки — рядом с вкладками, а не отдельной шапкой над чатом. */}
    <button className="workspace-tabs-chats" onClick={onSessions} title="Сохранённые чаты проекта — вернуться к любому" aria-label="Чаты проекта">
      <MessagesSquare size={14}/>
      <span>Чаты{sessionCount&&sessionCount>1?" · "+sessionCount:""}</span>
    </button>
    {/* Мгновенный переход к концу переписки: без плавной прокрутки, одним нажатием. */}
    {showScroll&&onScrollBottom&&<button className={"workspace-tabs-scroll"+(writing?" is-live":"")} onClick={onScrollBottom} title="Мгновенно прокрутить переписку вниз" aria-label="Прокрутить переписку вниз">
      <ArrowDownToLine size={14}/>
      <span>Вниз</span>
      {writing&&<i className="workspace-tabs-scroll-dot" aria-hidden="true"/>}
    </button>}
  </nav>;
}
