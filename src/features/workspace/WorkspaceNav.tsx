import { Bot,FolderGit2,GitBranch,ListTodo,Terminal } from "lucide-react";

export type WorkspaceView="agent"|"tasks"|"files"|"changes"|"terminal";

/**
 * Строка вкладок рабочей области. Кнопка «вниз» теперь живёт у нижнего края правой рельсы
 * переписки (см. AgentPanel): там она рядом с точками, которые и так показывают положение в чате,
 * и не занимает место в строке вкладок на телефоне. Список чатов переехал в колонку слева,
 * поэтому отдельной кнопки «Чаты» здесь больше нет.
 */
export function WorkspaceNav({view,onChange,onSecrets}:{view:WorkspaceView;onChange:(view:WorkspaceView)=>void;onSecrets?:()=>void}){
  return <nav className="workspace-tabs">
    <button className={view==="agent"?"active":""} onClick={()=>onChange("agent")} title="Чат с агентом"><Bot size={15}/> Агент</button>
    <button className={view==="tasks"?"active":""} onClick={()=>onChange("tasks")} title="Задачи проекта: список дел, который агент читает по запросу"><ListTodo size={15}/> Задачи</button>
    <button className={view==="files"?"active":""} onClick={()=>onChange("files")} title="Файлы проекта и редактор"><FolderGit2 size={15}/> Файлы</button>
    <button className={view==="changes"?"active":""} onClick={()=>onChange("changes")} title="Git: рабочие изменения, коммиты, ветки и история"><GitBranch size={15}/> Git</button>
    <button className={view==="terminal"?"active":""} onClick={()=>onChange("terminal")} title="Команды в папке проекта"><Terminal size={15}/> Терминал</button>
    {/* Ключи — текстовая кнопка на месте ракеты: действие, а не раздел, и подпись понятнее значка. */}
    {onSecrets&&<button className="workspace-tabs-keys" onClick={onSecrets} title="Секреты проекта: ключи и переменные окружения" aria-label="Ключи проекта">Ключи</button>}
  </nav>;
}
