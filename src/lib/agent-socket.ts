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
  /** Set on run.queued: how many runs are waiting ahead of this one. */
  queued?:number;
  limit?:number;
};

export function createAgentSocket(onEvent:(event:AgentSocketEvent)=>void,onError:()=>void){
  const configured=import.meta.env.VITE_WS_URL as string|undefined;
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  const socket=new WebSocket(configured||protocol+"//"+window.location.host+"/ws");
  socket.onmessage=event=>onEvent(JSON.parse(event.data) as AgentSocketEvent);
  socket.onerror=onError;
  return socket;
}
