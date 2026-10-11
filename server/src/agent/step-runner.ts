import type { ChatMessage } from "../types.js";
import type { Provider,ProviderToolCall } from "../provider.js";
import { getToolDefinitions } from "../tool-registry.js";
import type { AgentContext } from "./types.js";

export type StepUsage={promptTokens:number;completionTokens:number;estimated:boolean};
export type StepResult={text:string;calls:ProviderToolCall[];usage:StepUsage};

/** Rough fallback for providers that do not report streaming usage. */
const estimateTokens=(text:string)=>Math.max(1,Math.ceil(text.length/4));

export async function runAgentStep(provider:Provider,messages:ChatMessage[],model:string,context:AgentContext):Promise<StepResult>{
  let text="";const calls:ProviderToolCall[]=[];let reported:StepUsage|null=null;
  for await(const chunk of provider.stream(messages,model,getToolDefinitions(),context.signal)){
    if(context.signal?.aborted)throw new Error("Запуск агента отменён");
    if(chunk.type==="text"){text+=chunk.text;context.emit({type:"message.delta",runId:context.runId,delta:chunk.text});}
    else if(chunk.type==="tool_call")calls.push(chunk.call);
    else if(chunk.type==="usage")reported={promptTokens:chunk.promptTokens,completionTokens:chunk.completionTokens,estimated:false};
  }
  const usage:StepUsage=reported??{
    promptTokens:estimateTokens(JSON.stringify(messages)),
    completionTokens:estimateTokens(text+JSON.stringify(calls)),
    estimated:true
  };
  return {text,calls,usage};
}
