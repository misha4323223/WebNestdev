import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentRunRequest, ChatMessage } from "./types.js";
import { createProvider, type ProviderToolCall } from "./provider.js";
import { getTool, getToolDefinitions } from "./tool-registry.js";
export type EventSink = (event: AgentEvent) => void;
const systemPrompt = "You are WebNestdev, a web coding agent. Work only inside the user's project sandbox. Use tools to inspect and modify files. Never expose credentials. When building a runnable web app, inspect it first, make the required changes, run checks, and use preview.start when ready.";
export class AgentRuntime {
  async run(request: AgentRunRequest, emit: EventSink) {
    const runId=randomUUID(); emit({type:"run.started",runId});
    try {
      const messages: ChatMessage[]=[{role:"system",content:systemPrompt},...request.messages];
      const model=request.model??process.env.AI_MODEL??"llama3.2";
      const maxSteps=Number(process.env.AGENT_MAX_STEPS??12);
      for(let step=0;step<maxSteps;step++){
        let text=""; const calls:ProviderToolCall[]=[];
        for await(const chunk of provider.stream(messages,model,getToolDefinitions())){
          if(chunk.type==="text"){text+=chunk.text;emit({type:"message.delta",runId,delta:chunk.text});}
          else if(chunk.type==="tool_call") calls.push(chunk.call);
        }
        if(!calls.length){if(!text)emit({type:"message.delta",runId,delta:"Модель не вернула ответ."});emit({type:"run.completed",runId});return;}
        messages.push({role:"assistant",content:text,tool_calls:calls});
        for(const call of calls){
          emit({type:"tool.started",runId,toolCallId:call.id,name:call.name,input:call.arguments});
          try{
            const tool=getTool(call.name); if(!tool) throw new Error("Unknown tool: "+call.name);
            const output=await tool.execute(call.arguments,{projectId:request.projectId,runId});
            emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:call.id});
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output:{error:message}});
            messages.push({role:"tool",content:JSON.stringify({error:message}),tool_call_id:call.id});
          }
        }
      }
      throw new Error("Agent step limit reached");
    }catch(error){emit({type:"run.failed",runId,error:error instanceof Error?error.message:String(error)});}
  }
}