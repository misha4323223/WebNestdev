import type { ChatMessage,ReasoningEffort } from "../types.js";

export type ProviderToolCall={id:string;name:string;arguments:Record<string,unknown>};
export type ProviderChunk={type:"text";text:string}|{type:"reasoning";text:string}|{type:"tool_call";call:ProviderToolCall}|{type:"usage";promptTokens:number;completionTokens:number;cachedPromptTokens?:number;cacheWritePromptTokens?:number}|{type:"done"};
/**
 * Явный выбор upstream-провайдера внутри шлюза (Polza.ai, OpenRouter). `only` — белый список,
 * поэтому шлюз не подменит выбранного провайдера дорогим; `allowFallbacks` остаётся false, а
 * переход к следующему делает наш RoutedProvider. `maxPrice` — страховка в рублях за 1M токенов.
 */
export type UpstreamProviderRequest={
  only:string[];
  allowFallbacks:boolean;
  maxPrice?:{prompt?:number;completion?:number};
};

/**
 * Per-request provider options. `reasoning` overrides the server default for this run only;
 * `cacheKey` is a stable per-conversation key for gateways that route a cache series to one
 * upstream provider (Polza). It never contains raw project or conversation identifiers.
 * `upstream` pins one provider for this request; it is set by RoutedProvider, not by a caller.
 */
export type ProviderStreamOptions={reasoning?:ReasoningEffort;cacheKey?:string;upstream?:UpstreamProviderRequest};
export interface Provider{stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal,options?:ProviderStreamOptions):AsyncGenerator<ProviderChunk>}
