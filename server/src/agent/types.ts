import type { AgentEvent,AgentRunRequest } from "../types.js";

export type EventSink=(event:AgentEvent)=>void;
export type AgentContext={runId:string;request:AgentRunRequest;emit:EventSink};
