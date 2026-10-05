import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../types.js";
import { lines } from "./stream-lines.js";
import type { Provider,ProviderChunk } from "./provider-types.js";

export class OllamaProvider implements Provider{
  constructor(private base:string,private key?:string){}
  async *stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal):AsyncGenerator<ProviderChunk>{
    const response=await fetch(new URL("/api/chat",this.base),{method:"POST",signal,headers:{"content-type":"application/json",...(this.key?{authorization:"Bearer "+this.key}:{})},body:JSON.stringify({model,messages,tools,stream:true})});
    if(!response.ok)throw new Error("AI provider returned HTTP "+response.status);
    if(!response.body)throw new Error("AI provider returned no stream");
    for await(const line of lines(response.body)){
      if(!line)continue;
      const data=JSON.parse(line) as any;
      if(data.message?.content)yield {type:"text",text:data.message.content};
      for(const call of data.message?.tool_calls??[]){
        const fn=call.function??call;
        yield {type:"tool_call",call:{id:call.id??randomUUID(),name:fn.name,arguments:typeof fn.arguments==="string"?JSON.parse(fn.arguments):fn.arguments??{}}};
      }
      if(data.done)break;
    }
    yield {type:"done"};
  }
}
