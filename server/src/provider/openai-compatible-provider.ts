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

type WireToolCall={
  id:string;
  type:"function";
  function:{name:string;arguments:string};
};

type WireMessage=
  | {role:"user"|"system";content:string}
  | {role:"assistant";content:string;tool_calls?:WireToolCall[]}
  | {role:"tool";content:string;tool_call_id:string};

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
    const response=await fetch(chatCompletionsUrl(this.base),{
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
        "AI provider returned HTTP "+response.status+
        (detail?": "+detail.slice(0,500):"")
      );
    }
    if(!response.body)throw new Error("AI provider returned no stream");

    const pending=new Map<number,ProviderToolCall>();
    for await(const line of lines(response.body)){
      if(!line||line==="[DONE]")continue;
      const data=JSON.parse(line) as any;
      const delta=data.choices?.[0]?.delta;
      if(delta?.content)yield {type:"text",text:delta.content};
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
