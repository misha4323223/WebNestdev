import type { PlanState } from "./types";

export type AgentSocketEvent={
  type:string;
  runId?:string;
  delta?:string;
  error?:string;
  code?:string;
  name?:string;
  toolCallId?:string;
  input?:unknown;
  output?:unknown;
  plan?:PlanState;
  step?:number;
  maxSteps?:number;
  /** Context size of the step that just started, and the budget it is bounded by. */
  tokens?:number;
  budget?:number;
  /** Set on run.queued: how many runs are waiting ahead of this one. */
  queued?:number;
  limit?:number;
  /** Set on run.retrying: the provider refused this step, so it waits and tries again by itself. */
  attempt?:number;
  attempts?:number;
  waitSeconds?:number;
  /**
   * Set on secret.requested: the agent asks for a key. The event carries only the variable name, the
   * target file and the reason — the value is typed by the user and posted straight to the server.
   */
  requestId?:string;
  variable?:string;
  purpose?:string;
  file?:string;
  expiresAt?:number;
  /**
   * Set on access.requested: the agent needs provider credentials and the chat shows the fields of
   * that provider's cabinet. Values are posted straight to the server, never carried by the event.
   */
  kind?:"cloud"|"domain"|"service"|"database"|"yandex";
  provider?:string;
  fields?:Array<{key:string;label:string;placeholder:string;secret?:boolean;multiline?:boolean;optional?:boolean}>;
  steps?:string[];
  keyUrl?:string;
  docsUrl?:string;
  verificationNote?:string;
  writes?:boolean;
  defaultAllowWrites?:boolean;
  /**
   * Set on question.asked: the agent needs a decision and the panel opens the question window over
   * the message box. The answer is posted separately, so the run keeps waiting here.
   */
  question?:string;
  options?:Array<{label:string;description?:string;imageUrl?:string}>;
  multiSelect?:boolean;
  maxSelections?:number;
  allowCustom?:boolean;
  /**
   * Set on changes.created: the finished task was written to the project's history.
   * `pushed` is false because only the user sends commits to GitHub.
   */
  checkpoint?:{sha:string;shortSha:string;subject:string;filesChanged:number};
  branch?:string;
  pushed?:boolean;
  pushError?:string;
};

export function createAgentSocket(onEvent:(event:AgentSocketEvent)=>void,onError:()=>void){
  const configured=import.meta.env.VITE_WS_URL as string|undefined;
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  const socket=new WebSocket(configured||protocol+"//"+window.location.host+"/ws");
  socket.onmessage=event=>onEvent(JSON.parse(event.data) as AgentSocketEvent);
  socket.onerror=onError;
  return socket;
}
