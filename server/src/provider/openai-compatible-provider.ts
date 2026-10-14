import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../types.js";
import { lines } from "./stream-lines.js";
import type { Provider,ProviderChunk,ProviderToolCall } from "./provider-types.js";

function chatCompletionsUrl(baseUrl:string){
  const base=baseUrl.trim().replace(/\/+$/,"");
  return base.endsWith("/v1")
    ? base+"/chat/completions"
    : base+"/v1/chat/completions";
}

// AI-прокси: если задан AI_PROXY_URL, запрос идёт через зарубежный прокси.
const proxyUrl=(process.env.AI_PROXY_URL??"").replace(/\/+$/,"");
const proxyToken=(process.env.AI_PROXY_TOKEN??"").trim();

type WireToolCall={
  id:string;
  type:"function";
  function:{name:string;arguments:string};
};

type WireMessage=
  | {role:"user"|"system";content:string}
  | {role:"assistant";content:string;tool_calls?:WireToolCall[]}
  | {role:"tool";content:string;tool_call_id:string};

/**
 * Reasoning-capable models stream their chain of thought in one of several fields,
 * depending on the gateway: DeepSeek uses `reasoning_content`, Qwen `reasoning`, and a
 * few gateways send `reasoning_details`. Any of them becomes a reasoning chunk. It is
 * shown to the user and never sent back to the provider.
 */
function reasoningDelta(delta:unknown):string{
  if(!delta||typeof delta!=="object")return "";
  const value=delta as {reasoning_content?:unknown;reasoning?:unknown;reasoning_details?:unknown};
  if(typeof value.reasoning_content==="string")return value.reasoning_content;
  if(typeof value.reasoning==="string")return value.reasoning;
  if(Array.isArray(value.reasoning_details)){
    return value.reasoning_details
      .map(item => (item&&typeof item==="object"&&typeof (item as {text?:unknown}).text==="string" ? (item as {text:string}).text : ""))
      .join("");
  }
  return "";
}

export function toWireMessages(messages:ChatMessage[]):WireMessage[]{
  return messages.map(message=>{
    if(message.role==="assistant"){
      if(!message.tool_calls?.length){
        return {role:"assistant",content:message.content};
      }
      return {
      role:"assistant",
      content:message.content,
      tool_calls:message.tool_calls.map(call=>({
        id:call.id,
        type:"function",
        function:{
          name:call.name,
          arguments:JSON.stringify(call.arguments??{})
        }
      }))
      };
    }
    return message;
  });
}

export class OpenAICompatibleProvider implements Provider{
  constructor(private base:string,private key?:string){}

  async *stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal):AsyncGenerator<ProviderChunk>{
    const targetUrl=chatCompletionsUrl(this.base);
    // Для прокси: шлём только суффикс (без домена), target идёт в X-AI-Proxy-Target.
    // Если base оканчивается на /v1 — суффикс /chat/completions, иначе /v1/chat/completions.
    // Так склейка на стороне прокси всегда корректная (нет дублей /v1/v1 и /api/v1/api/v1).
    const normBase=this.base.trim().replace(/\/+$/,"");
    const chatPath=normBase.endsWith("/v1")?"/chat/completions":"/v1/chat/completions";
    const response=proxyUrl
      ? await fetch(proxyUrl+chatPath,{
        method:"POST",
        signal,
        headers:{
          "content-type":"application/json",
          "x-ai-proxy-target":this.base.replace(/\/+$/,""),
          ...(proxyToken?{"x-proxy-token":proxyToken}:{}),
          ...(this.key?{authorization:"Bearer "+this.key}:{})
        },
        body:JSON.stringify({model,messages:toWireMessages(messages),tools,stream:true})
      })
      : await fetch(targetUrl,{
        method:"POST",
        signal,
        headers:{
          "content-type":"application/json",
          ...(this.key?{authorization:"Bearer "+this.key}:{})
        },
        body:JSON.stringify({model,messages:toWireMessages(messages),tools,stream:true})
      });
    if(!response.ok){
      const detail=await response.text().catch(()=>"");
      throw new Error(
        "Провайдер вернул HTTP "+response.status+
        (detail?": "+detail.slice(0,500):"")
      );
    }
    if(!response.body)throw new Error("Провайдер не вернул поток данных");

    const pending=new Map<number,ProviderToolCall>();
    for await(const line of lines(response.body)){
      if(!line||line==="[DONE]")continue;
      const data=JSON.parse(line) as any;
      if(data.usage){
        yield {type:"usage",promptTokens:Number(data.usage.prompt_tokens??0),completionTokens:Number(data.usage.completion_tokens??0)};
      }
      const delta=data.choices?.[0]?.delta;
      if(delta?.content)yield {type:"text",text:delta.content};
      const reasoning=reasoningDelta(delta);
      if(reasoning)yield {type:"reasoning",text:reasoning};
      for(const call of delta?.tool_calls??[]){
        const index=call.index??0;
        const existing=pending.get(index)??{
          id:call.id??randomUUID(),
          name:call.function?.name??"",
          arguments:{}
        };
        if(call.id)existing.id=call.id;
        if(call.function?.name)existing.name=call.function.name;
        const fragment=call.function?.arguments;
        if(fragment){
          const raw=(existing as any).__raw??"";
          (existing as any).__raw=raw+fragment;
          try{existing.arguments=JSON.parse((existing as any).__raw)}catch{}
        }
        pending.set(index,existing);
      }
    }
    for(const call of pending.values()){
      delete (call as any).__raw;
      yield {type:"tool_call",call};
    }
    yield {type:"done"};
  }
}
