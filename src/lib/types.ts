export type ChatMessage={role:"user"|"assistant";content:string};
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
