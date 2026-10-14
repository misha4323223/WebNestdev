import { AgentPanel } from "../agent/AgentPanel";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import type { WorkspaceView } from "./WorkspaceNav";

export function WorkspaceContent({view,projectId,conversationId,onOpenConversation,onRunFinished,onOpenModelSettings,onOpenAccountSettings}:{view:WorkspaceView;projectId:string;conversationId:string;onOpenConversation:(id:string)=>void;onRunFinished:()=>void;onOpenModelSettings:()=>void;onOpenAccountSettings:()=>void}){
  if(view==="files")return <FilePanel projectId={projectId}/>;
  if(view==="terminal")return <TerminalPanel projectId={projectId}/>;
  return <AgentPanel projectId={projectId} conversationId={conversationId} onOpenConversation={onOpenConversation} onChanged={onRunFinished} onOpenModelSettings={onOpenModelSettings} onOpenAccountSettings={onOpenAccountSettings}/>;
}
