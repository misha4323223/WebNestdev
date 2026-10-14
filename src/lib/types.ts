export type ChatMessage={
  role:"user"|"assistant"|"tool";
  content:string;
  /** What the model thought before answering; kept in the history and shown on demand. */
  reasoning?:string;
  /** Tool calls a stored assistant turn made, used to rebuild the action list. */
  tool_calls?:Array<{id:string;name:string;arguments:Record<string,unknown>}>;
  /** Set on a stored tool result: the call this message answers. */
  tool_call_id?:string;
};
/** "planner" only studies the project and publishes a plan; "developer" applies changes. */
export type AgentMode="planner"|"developer";
export type FileEntry={name:string;type:"file"|"directory"};
export type PreviewState={running:boolean;port?:number};

export type PlanItemStatus="pending"|"in_progress"|"done";
export type PlanItem={title:string;status:PlanItemStatus;note?:string};
/** The task plan the agent publishes with plan.update and the user watches live. */
export type PlanState={items:PlanItem[];updatedAt:string};
/** One tool call shown in the activity feed of a run. */
export type AgentAction={id:string;name:string;target:string;status:"running"|"done"|"failed";startedAt:number;durationMs?:number};
