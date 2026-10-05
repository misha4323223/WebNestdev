import type { ChatMessage } from "../types.js";

export type ProviderToolCall={id:string;name:string;arguments:Record<string,unknown>};
export type ProviderChunk={type:"text";text:string}|{type:"tool_call";call:ProviderToolCall}|{type:"done"};
export interface Provider{stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal):AsyncGenerator<ProviderChunk>}
