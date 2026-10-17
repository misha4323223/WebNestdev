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
};

export function createAgentSocket(onEvent:(event:AgentSocketEvent)=>void,onError:()=>void){
  const configured=import.meta.env.VITE_WS_URL as string|undefined;
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  const socket=new WebSocket(configured||protocol+"//"+window.location.host+"/ws");
  socket.onmessage=event=>onEvent(JSON.parse(event.data) as AgentSocketEvent);
  socket.onerror=onError;
  return socket;
}
