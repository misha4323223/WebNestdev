import { AgentPanel } from "../agent/AgentPanel";
import { FilePanel } from "../files/FilePanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import type { WorkspaceView } from "./WorkspaceNav";

export function WorkspaceContent({view,projectId,conversationId}:{view:WorkspaceView;projectId:string;conversationId:string}){
  if(view==="files")return <FilePanel projectId={projectId}/>;
  if(view==="terminal")return <TerminalPanel projectId={projectId}/>;
  return <AgentPanel projectId={projectId} conversationId={conversationId} onChanged={()=>{}}/>;
}
