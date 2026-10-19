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
/** How deeply the model is asked to reason before answering. */
export type ReasoningEffort="low"|"medium"|"high";
export type FileEntry={name:string;type:"file"|"directory"};
/** `static` serves the built app without a dev server, so there is no hot reload. */
export type PreviewMode="container"|"static";
/**
 * `ready` — приложение ответило внутри контейнера, `settled` — тот же адрес ответил серверу (то
 * есть панели и агенту); `hint` объясняет, чего именно не хватает. Разница видна пользователю:
 * «готов, но недоступен» — это белый экран в панели, а не ожидание запуска. `viaExec` — третий
 * случай: адрес контейнера серверу недоступен, и приложение отдаётся панели через `docker exec`.
 */
export type PreviewState={running:boolean;port?:number;ready?:boolean;settled?:boolean;viaExec?:boolean;mode?:PreviewMode;hint?:string;error?:string;
/** Публичный адрес предпросмотра (`https://<проект>.preview.домен`), когда он настроен на сервере. */
publicUrl?:string};

export type PlanItemStatus="pending"|"in_progress"|"done";
export type PlanItem={title:string;status:PlanItemStatus;note?:string};
/** The task plan the agent publishes with plan.update and the user watches live. */
export type PlanState={items:PlanItem[];updatedAt:string};
/** One tool call shown in the activity feed of a run. */
export type AgentAction={
  id:string;
  name:string;
  target:string;
  status:"running"|"done"|"failed";
  startedAt:number;
  durationMs?:number;
  /** The arguments the model sent, kept for the expandable action details. */
  input?:unknown;
  /** The tool result, or undefined while the call is still running. */
  output?:unknown;
  /**
   * Full previous file content when it is known from an earlier read or write.
   * An empty string means the file was known to be empty; undefined means unknown.
   */
  before?:string;
};
