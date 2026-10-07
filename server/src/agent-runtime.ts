import { randomUUID } from "node:crypto";
import type { AgentRunRequest,ChatMessage } from "./types.js";
import { createProvider } from "./provider.js";
import { appendConversationMessages,getProject,getProjectProvider } from "./project-store.js";
import { buildInitialMessages } from "./agent/message-builder.js";
import { executeTool } from "./agent/tool-executor.js";
import { runAgentStep } from "./agent/step-runner.js";
import type { EventSink } from "./agent/types.js";

export class AgentRuntime {
  async run(request:AgentRunRequest,emit:EventSink,signal?:AbortSignal){
    const runId=randomUUID(); emit({type:"run.started",runId});
    try{
      const project=await getProject(request.projectId);
      if(!project||project.userId!==request.userId)throw new Error("Project not found");
      const config=await getProjectProvider(request.projectId);
      const provider=createProvider(config??undefined);
      const messages:ChatMessage[]=buildInitialMessages(request.messages);
      const model=request.model??config?.model;
      if(!model)throw new Error("AI model is not configured");
      const maxSteps=Math.min(50,Math.max(1,Number(process.env.AGENT_MAX_STEPS??20)));
      for(let step=0;step<maxSteps;step++){
        if(signal?.aborted)throw new Error("Agent run cancelled");
        emit({type:"run.progress",runId,step:step+1,maxSteps});
        const context={runId,request,emit,signal};
        const result=await runAgentStep(provider,messages,model,context);
        if(!result.calls.length){
          const text=result.text||"Модель не вернула ответ.";
          if(!result.text)emit({type:"message.delta",runId,delta:text});
          if(request.conversationId){
            const conversation=await import("./project-store.js").then(m=>m.getConversation(request.conversationId!));
            if(!conversation||conversation.projectId!==request.projectId)throw new Error("Conversation not found for project");
            await appendConversationMessages(request.conversationId,[{role:"assistant",content:text}]);
          }
          emit({type:"run.completed",runId}); return;
        }
        messages.push({role:"assistant",content:result.text,tool_calls:result.calls});
        for(const call of result.calls){
          if(signal?.aborted)throw new Error("Agent run cancelled");
          emit({type:"tool.started",runId,toolCallId:call.id,name:call.name,input:call.arguments});
          try{
            const output=await executeTool(call,context);
            if(signal?.aborted)throw new Error("Agent run cancelled");
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