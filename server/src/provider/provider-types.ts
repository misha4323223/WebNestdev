import type { ChatMessage,ReasoningEffort } from "../types.js";

export type ProviderToolCall={id:string;name:string;arguments:Record<string,unknown>};
export type ProviderChunk={type:"text";text:string}|{type:"reasoning";text:string}|{type:"tool_call";call:ProviderToolCall}|{type:"usage";promptTokens:number;completionTokens:number}|{type:"done"};
/** Per-request provider options; `reasoning` overrides the server default for this run only. */
export type ProviderStreamOptions={reasoning?:ReasoningEffort};
export interface Provider{stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal,options?:ProviderStreamOptions):AsyncGenerator<ProviderChunk>}
