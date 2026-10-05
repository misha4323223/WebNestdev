import { randomUUID } from "node:crypto";
import type { AgentRunRequest,ChatMessage } from "./types.js";
import { createProvider } from "./provider.js";
import { appendConversationMessages } from "./project-store.js";
import { buildInitialMessages } from "./agent/message-builder.js";
import { executeTool } from "./agent/tool-executor.js";
import { runAgentStep } from "./agent/step-runner.js";
import type { EventSink } from "./agent/types.js";

export class AgentRuntime {
  private readonly provider=createProvider();

  async run(request:AgentRunRequest,emit:EventSink){
    const runId=randomUUID();
    emit({type:"run.started",runId});
    try{
      const messages:ChatMessage[]=buildInitialMessages(request.messages);
      const model=request.model??process.env.AI_MODEL??"llama3.2";
      const maxSteps=Number(process.env.AGENT_MAX_STEPS??12);

      for(let step=0;step<maxSteps;step++){
        const context={runId,request,emit};
        const result=await runAgentStep(this.provider,messages,model,context);
        if(!result.calls.length){
          const text=result.text||"Модель не вернула ответ.";
          if(!result.text)emit({type:"message.delta",runId,delta:text});
          if(request.conversationId)await appendConversationMessages(request.conversationId,[{role:"assistant",content:result.text}]);
          emit({type:"run.completed",runId});
          return;
        }

        messages.push({role:"assistant",content:result.text,tool_calls:result.calls});
        for(const call of result.calls){
          emit({type:"tool.started",runId,toolCallId:call.id,name:call.name,input:call.arguments});
          try{
            const output=await executeTool(call,context);
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
    }catch(error){
      emit({type:"run.failed",runId,error:error instanceof Error?error.message:String(error)});
    }
  }
}
