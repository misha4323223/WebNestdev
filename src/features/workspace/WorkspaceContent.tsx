import { AgentPanel } from "../agent/AgentPanel";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import type { WorkspaceView } from "./WorkspaceNav";

/**
 * Панель агента остаётся смонтированной, пока открыты «Файлы» или «Терминал»: запуск живёт,
 * пока открыт её сокет, поэтому переключение вкладки не прерывает работу, а возвращение
 * на «Агент» показывает уже дописанный ход. Остальные панели монтируются только когда видны —
 * у них нет фоновой работы, зато есть запросы к проекту.
 */
export function WorkspaceContent({view,projectId,conversationId,onOpenConversation,onRunFinished,onOpenModelSettings,onOpenAccountSettings,onRunningChange}:{view:WorkspaceView;projectId:string;conversationId:string;onOpenConversation:(id:string)=>void;onRunFinished:()=>void;onOpenModelSettings:()=>void;onOpenAccountSettings:()=>void;onRunningChange?:(running:boolean)=>void}){
  return <>
    <div className="workspace-view" hidden={view!=="agent"}>
      <AgentPanel projectId={projectId} conversationId={conversationId} onOpenConversation={onOpenConversation} onChanged={onRunFinished} onOpenModelSettings={onOpenModelSettings} onOpenAccountSettings={onOpenAccountSettings} onRunningChange={onRunningChange}/>
    </div>
    {view==="files"&&<FilePanel projectId={projectId}/>}
    {view==="terminal"&&<TerminalPanel projectId={projectId}/>}
  </>;
}
