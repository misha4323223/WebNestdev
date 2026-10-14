export type Role="user"|"assistant"|"system"|"tool";
export type ChatMessage=
  | {role:"user"|"system";content:string}
  /** `reasoning` is what the model thought before answering; it is kept for the user, never sent back to the provider. */
  | {role:"assistant";content:string;reasoning?:string;tool_calls?:Array<{id:string;name:string;arguments:Record<string,unknown>}>}
  | {role:"tool";content:string;tool_call_id:string};
export type PlanItemStatus="pending"|"in_progress"|"done";
export type PlanItem={title:string;status:PlanItemStatus;note?:string};
export type PlanState={items:PlanItem[];updatedAt:string};
export type AgentEvent=
  | {type:"run.started";runId:string}
  | {type:"message.delta";runId:string;delta:string}
  | {type:"reasoning.delta";runId:string;delta:string}
  | {type:"tool.started";runId:string;toolCallId:string;name:string;input:unknown}
  | {type:"tool.finished";runId:string;toolCallId:string;name:string;output:unknown}
  | {type:"plan.updated";runId:string;plan:PlanState}
  /** `tokens`/`budget` are the context size of the step that is starting (agent/context-budget.ts). */
  | {type:"run.progress";runId:string;step:number;maxSteps:number;tokens?:number;budget?:number}
  | {type:"run.completed";runId:string}
  /** `code` is a machine-readable reason (CONTEXT_OVERFLOW, AUTH, RATE_LIMIT) for the panel. */
  | {type:"run.failed";runId:string;error:string;code?:string};
/**
 * "planner" studies the project and publishes a plan without touching files;
 * "developer" is the full agent that writes code and verifies the result.
 */
export type AgentMode="planner"|"developer";
/**
 * `resume` marks a run that continues an interrupted one: the history arrives as usual, but the
 * runtime tells the model that this is a continuation and where the plan stopped.
 */
export type AgentRunRequest={projectId:string;conversationId?:string;messages:ChatMessage[];model?:string;mode?:AgentMode;resume?:{reason?:string};userId:string};
export type ToolContext={projectId:string;runId:string;userId:string};
export type ToolHandler=(input:unknown,context:ToolContext)=>Promise<unknown>;
export type ToolDefinition={name:string;description:string;execute?:ToolHandler;async?:ToolHandler;/** Optional JSON Schema sent to the provider so the model knows the exact input shape. */parameters?:Record<string,unknown>};