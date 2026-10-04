import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./types.js";
export type ProviderToolCall={id:string;name:string;arguments:Record<string,unknown>};
export type ProviderChunk={type:"text";text:string}|{type:"tool_call";call:ProviderToolCall}|{type:"done"};
export interface Provider{stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal):AsyncGenerator<ProviderChunk>}
export function createProvider():Provider{const base=process.env.AI_BASE_URL??"http://localhost:11434";const key=process.env.AI_API_KEY;return(process.env.AI_PROVIDER??"ollama")==="ollama"?new OllamaProvider(base,key):new OpenAICompatibleProvider(base,key)}
class OllamaProvider implements Provider{
 constructor(private base:string,private key?:string){}
 async *stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal){
  const r=await fetch(new URL("/api/chat",this.base),{method:"POST",signal,headers:{"content-type":"application/json",...(this.key?{authorization:"Bearer "+this.key}:{})},body:JSON.stringify({model,messages,tools,stream:true})});
  if(!r.ok)throw new Error("AI provider returned HTTP "+r.status); if(!r.body)throw new Error("AI provider returned no stream");
  for await(const line of lines(r.body)){if(!line)continue;const d=JSON.parse(line) as any;if(d.message?.content)yield{type:"text",text:d.message.content};for(const c of d.message?.tool_calls??[]){const f=c.function??c;yield{type:"tool_call",call:{id:c.id??randomUUID(),name:f.name,arguments:typeof f.arguments==="string"?JSON.parse(f.arguments):f.arguments??{}}}}if(d.done)break}
  yield{type:"done"};
 }
}
class OpenAICompatibleProvider implements Provider{
 constructor(private base:string,private key?:string){}
 async *stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal){
  const r=await fetch(new URL("/v1/chat/completions",this.base),{method:"POST",signal,headers:{"content-type":"application/json",...(this.key?{authorization:"Bearer "+this.key}:{})},body:JSON.stringify({model,messages,tools,stream:true})});
  if(!r.ok)throw new Error("AI provider returned HTTP "+r.status); if(!r.body)throw new Error("AI provider returned no stream");
  const pending=new Map<number,ProviderToolCall>();
  for await(const line of lines(r.body)){if(!line||line==="[DONE]")continue;const d=JSON.parse(line) as any;const ch=d.choices?.[0]?.delta;if(ch?.content)yield{type:"text",text:ch.content};for(const c of ch?.tool_calls??[]){const index=c.index??0;const existing=pending.get(index)??{id:c.id??randomUUID(),name:c.function?.name??"",arguments:{}};if(c.id)existing.id=c.id;if(c.function?.name)existing.name=c.function.name;const fragment=c.function?.arguments;if(fragment){const old=(existing as any).__raw??"";(existing as any).__raw=old+fragment;try{existing.arguments=JSON.parse((existing as any).__raw)}catch{}}pending.set(index,existing)}}
  for(const call of pending.values()){delete (call as any).__raw;yield{type:"tool_call",call};} yield{type:"done"};
 }
}
async function* lines(body:ReadableStream<Uint8Array>){const reader=body.getReader();const decoder=new TextDecoder();let buffer="";try{while(true){const{value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parts=buffer.split("\n");buffer=parts.pop()??"";for(const line of parts){const v=line.trim();if(v)yield v.startsWith("data:")?v.slice(5).trim():v}}}finally{reader.releaseLock()}}