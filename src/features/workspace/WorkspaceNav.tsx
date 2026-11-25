import { Bot,FolderGit2,GitBranch,Globe2,Images,KeyRound,ListTodo,Terminal } from "lucide-react";

export type WorkspaceView="agent"|"tasks"|"files"|"media"|"changes"|"terminal"|"hosting";

/**
 * Строка вкладок рабочей области. Кнопка «вниз» теперь живёт у нижнего края правой рельсы
 * переписки (см. AgentPanel): там она рядом с точками, которые и так показывают положение в чате,
 * и не занимает место в строке вкладок на телефоне. Список чатов переехал в колонку слева,
 * поэтому отдельной кнопки «Чаты» здесь больше нет.
 */
export function WorkspaceNav({view,onChange,onSecrets,canUseTerminal}:{view:WorkspaceView;onChange:(view:WorkspaceView)=>void;onSecrets?:()=>void;canUseTerminal?:boolean}){
  return <nav className="workspace-tabs">
    <button className={view==="agent"?"active":""} onClick={()=>onChange("agent")} title="Чат с агентом"><span className="workspace-tab-icon"><Bot size={15}/></span><span className="workspace-tab-label">Агент</span></button>
    <button className={view==="tasks"?"active":""} onClick={()=>onChange("tasks")} title="Задачи проекта: список дел, который агент читает по запросу"><span className="workspace-tab-icon"><ListTodo size={15}/></span><span className="workspace-tab-label">Задачи</span></button>
    <button className={view==="files"?"active":""} onClick={()=>onChange("files")} title="Файлы проекта и редактор"><span className="workspace-tab-icon"><FolderGit2 size={15}/></span><span className="workspace-tab-label">Файлы</span></button>
    <button className={view==="media"?"active":""} onClick={()=>onChange("media")} title="Вложения в хранилище: замена, переименование и удаление"><span className="workspace-tab-icon"><Images size={15}/></span><span className="workspace-tab-label">Вложения</span></button>
    <button className={view==="changes"?"active":""} onClick={()=>onChange("changes")} title="Git: рабочие изменения, коммиты, ветки и история"><span className="workspace-tab-icon"><GitBranch size={15}/></span><span className="workspace-tab-label">Git</span></button>
    {/* Терминал — возможность Премиума; сервер проверяет то же правило на маршруте. */}
    {canUseTerminal&&<button className={view==="terminal"?"active":""} onClick={()=>onChange("terminal")} title="Команды в папке проекта"><span className="workspace-tab-icon"><Terminal size={15}/></span><span className="workspace-tab-label">Терминал</span></button>}
    {/* Публикация — статический сайт по HTTPS, без процесса и контейнера после публикации. */}
    <button className={view==="hosting"?"active":""} onClick={()=>onChange("hosting")} title="Статический сайт проекта по HTTPS"><span className="workspace-tab-icon"><Globe2 size={15}/></span><span className="workspace-tab-label">Публикация</span></button>
    {/* Ключи — действие, а не раздел, но иконка та же, что у остальных вкладок: без неё
        подпись выбивалась из строки и читалась как случайная ссылка. */}
    {onSecrets&&<button className="workspace-tabs-keys" onClick={onSecrets} title="Секреты проекта: ключи и переменные окружения" aria-label="Ключи проекта"><span className="workspace-tab-icon"><KeyRound size={15}/></span><span className="workspace-tab-label">Ключи</span></button>}
  </nav>;
}
