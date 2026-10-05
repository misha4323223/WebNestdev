export type Role="user"|"assistant"|"system"|"tool";
export type ChatMessage=
  | {role:"user"|"system";content:string}
  | {role:"assistant";content:string;tool_calls?:Array<{id:string;name:string;arguments:Record<string,unknown>}>}
  | {role:"tool";content:string;tool_call_id:string};
export type AgentEvent=
  | {type:"run.started";runId:string}
  | {type:"message.delta";runId:string;delta:string}
  | {type:"tool.started";runId:string;toolCallId:string;name:string;input:unknown}
  | {type:"tool.finished";runId:string;toolCallId:string;name:string;output:unknown}
  | {type:"run.completed";runId:string}
  | {type:"run.failed";runId:string;error:string};
export type AgentRunRequest={projectId:string;conversationId?:string;messages:ChatMessage[];model?:string};
export type ToolContext={projectId:string;runId:string};
export type ToolDefinition={name:string;description:string;execute:(input:unknown,context:ToolContext)=>Promise<unknown>};
