import type { ChatMessage } from "../types.js";
import type { Provider,ProviderToolCall } from "../provider.js";
import { getToolDefinitions } from "../tool-registry.js";
import type { AgentContext } from "./types.js";
export type StepResult={text:string;calls:ProviderToolCall[]};
export async function runAgentStep(provider:Provider,messages:ChatMessage[],model:string,context:AgentContext):Promise<StepResult>{
  let text="";const calls:ProviderToolCall[]=[];
  for await(const chunk of provider.stream(messages,model,getToolDefinitions(),context.signal)){
    if(context.signal?.aborted)throw new Error("Agent run cancelled");
    if(chunk.type==="text"){text+=chunk.text;context.emit({type:"message.delta",runId:context.runId,delta:chunk.text});}
    else if(chunk.type==="tool_call")calls.push(chunk.call);
  }
  return {text,calls};
}
