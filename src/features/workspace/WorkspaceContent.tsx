import { AgentPanel } from "../agent/AgentPanel";
import { ChangesPanel } from "../changes/ChangesPanel";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import type { WorkspaceView } from "./WorkspaceNav";

/**
 * Панель агента остаётся смонтированной, пока открыты «Файлы», «Изменения» или «Терминал»:
 * запуск живёт, пока открыт её сокет, поэтому переключение вкладки не прерывает работу,
 * а возвращение на «Агент» показывает уже дописанный ход. Остальные панели монтируются
 * только когда видны — у них нет фоновой работы, зато есть запросы к проекту.
 */
export function WorkspaceContent({view,projectId,projectName,conversationId,onRunFinished,onOpenModelSettings,onOpenAccountSettings,onRunningChange,onOpenChanges,scrollSignal,onChatEndChange}:{view:WorkspaceView;projectId:string;projectName:string;conversationId:string;onRunFinished:()=>void;onOpenModelSettings:()=>void;onOpenAccountSettings:()=>void;onRunningChange?:(running:boolean)=>void;onOpenChanges?:()=>void;scrollSignal?:number;onChatEndChange?:(atEnd:boolean)=>void}){
  return <>
    <div className="workspace-view" hidden={view!=="agent"}>
      <AgentPanel projectId={projectId} conversationId={conversationId} onChanged={onRunFinished} onOpenModelSettings={onOpenModelSettings} onOpenAccountSettings={onOpenAccountSettings} onRunningChange={onRunningChange} onOpenChanges={onOpenChanges} scrollSignal={scrollSignal} onChatEndChange={onChatEndChange}/>
    </div>
    {view==="files"&&<FilePanel projectId={projectId}/>}
    {view==="changes"&&<ChangesPanel projectId={projectId} projectName={projectName} onRolledBack={onRunFinished}/>}
    {view==="terminal"&&<TerminalPanel projectId={projectId}/>}
  </>;
}
