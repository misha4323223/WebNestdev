import { AgentPanel } from "../agent/AgentPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { TasksPanel } from "../tasks/TasksPanel";
import type { WorkspaceView } from "./WorkspaceNav";

/**
 * Панель агента остаётся смонтированной, пока открыты «Файлы», «Изменения» или «Терминал»:
 * запуск живёт, пока открыт её сокет, поэтому переключение вкладки не прерывает работу,
 * а возвращение на «Агент» показывает уже дописанный ход. Остальные панели монтируются
 * только когда видны — у них нет фоновой работы, зато есть запросы к проекту.
 */
export function WorkspaceContent({view,projectId,projectName,conversationId,onRunFinished,onFileSaved,onOpenModelSettings,onOpenAccountSettings,onRunningChange,onOpenChanges,scrollSignal,onChatEndChange,onScrollBottom,showScroll,writing,taskReload}:{view:WorkspaceView;projectId:string;projectName:string;conversationId:string;onRunFinished:()=>void;onFileSaved?:()=>void;onOpenModelSettings:()=>void;onOpenAccountSettings:()=>void;onRunningChange?:(running:boolean)=>void;onOpenChanges?:()=>void;scrollSignal?:number;onChatEndChange?:(atEnd:boolean)=>void;onScrollBottom?:()=>void;showScroll?:boolean;writing?:boolean;taskReload?:number}){
  return <>
    <div className="workspace-view" hidden={view!=="agent"}>
      <AgentPanel projectId={projectId} conversationId={conversationId} onChanged={onRunFinished} onOpenModelSettings={onOpenModelSettings} onOpenAccountSettings={onOpenAccountSettings} onRunningChange={onRunningChange} onOpenChanges={onOpenChanges} scrollSignal={scrollSignal} onChatEndChange={onChatEndChange} onScrollBottom={onScrollBottom} showScroll={showScroll} writing={writing}/>
    </div>
    {view==="tasks"&&<TasksPanel projectId={projectId} reloadToken={taskReload}/>}
    {view==="files"&&<FilePanel projectId={projectId} projectName={projectName} onSaved={onFileSaved}/>}
    {view==="changes"&&<ChangesPanel projectId={projectId} projectName={projectName} onRolledBack={onRunFinished}/>}
    {view==="terminal"&&<TerminalPanel projectId={projectId}/>}
  </>;
}
