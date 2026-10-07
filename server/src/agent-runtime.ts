import { randomUUID } from "node:crypto";
import type { AgentRunRequest,ChatMessage } from "./types.js";
import { createProvider } from "./provider.js";
import { appendConversationMessages,getProject,getProjectProvider } from "./project-store.js";
import { buildInitialMessages } from "./agent/message-builder.js";
import { buildProjectContext } from "./agent/context-builder.js";
import { retrieveRelevantFiles } from "./agent/context-retrieval.js";
import { executeTool } from "./agent/tool-executor.js";
import { runAgentStep } from "./agent/step-runner.js";
import type { EventSink } from "./agent/types.js";

const MAX_CONSECUTIVE_VERIFY_FAILURES=3;
const MUTATING_TOOLS=new Set(["fs.write","fs.rename","fs.delete","terminal.exec","npm.install"]);

function shouldRunBrowserRuntime(name:string,args:Record<string,unknown>){
  if(name==="fs.write"||name==="fs.rename"){
    const value=typeof args.path==="string"?args.path:typeof args.to==="string"?args.to:"";
    return /\.(tsx?|jsx?|html?|css|scss|vue|svelte)$/i.test(value)||/^(src|app|pages|components)\//i.test(value);
  }
  if(name==="terminal.exec"){
    const command=typeof args.command==="string"?args.command:"";
    return /(^|\s)(npm\s+(run|install)|pnpm\s+(run|install)|yarn\s+(run|install)|vite|next|react|webpack|tsc)\b/i.test(command);
  }
  return name==="npm.install";
}

export class AgentRuntime {
  async run(request:AgentRunRequest,emit:EventSink,signal?:AbortSignal){
    const runId=randomUUID(); emit({type:"run.started",runId});
    try{
      const project=await getProject(request.projectId);
      if(!project||project.userId!==request.userId)throw new Error("Project not found");
      const config=await getProjectProvider(request.projectId);
      const provider=createProvider(config??undefined);
      const projectContext=await buildProjectContext(project,request.userId);
      const task=request.messages.filter(message=>message.role==="user").at(-1)?.content??"";
      const relevantFiles=await retrieveRelevantFiles(request.projectId,request.userId,task);
      const messages:ChatMessage[]=buildInitialMessages(request.messages,projectContext+"\n\nTASK-RELEVANT SOURCE FILES\n"+relevantFiles);
      const model=request.model??config?.model;
      if(!model)throw new Error("AI model is not configured");
      const maxSteps=Math.min(50,Math.max(1,Number(process.env.AGENT_MAX_STEPS??20)));
      let consecutiveVerifyFailures=0;

      const runVerification=async (browserRuntime:boolean)=>{
        const verifyCalls=[
          {id:randomUUID(),name:"preview.start",arguments:{}},
          {id:randomUUID(),name:"project.verify",arguments:{}},
          ...(browserRuntime?[{id:randomUUID(),name:"browser.runtime",arguments:{}}]:[]),
        ];
        for(const verifyCall of verifyCalls){
          if(signal?.aborted)throw new Error("Agent run cancelled");
          emit({type:"tool.started",runId,toolCallId:verifyCall.id,name:verifyCall.name,input:verifyCall.arguments});
          try{
            const output=await executeTool(verifyCall as any,{runId,request,emit,signal});
            emit({type:"tool.finished",runId,toolCallId:verifyCall.id,name:verifyCall.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:verifyCall.id});
            if(verifyCall.name==="project.verify" && !(output as {ok?:boolean}).ok) return false;
            if(verifyCall.name==="browser.runtime" && !(output as {ok?:boolean}).ok) return false;
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            const output={error:message};
            emit({type:"tool.finished",runId,toolCallId:verifyCall.id,name:verifyCall.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:verifyCall.id});
            return false;
          }
        }
        return true;
      };

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
          let toolSucceeded=false;
          try{
            const output=await executeTool(call,context);
            if(signal?.aborted)throw new Error("Agent run cancelled");
            toolSucceeded=true;
            emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:call.id});
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output:{error:message}});
            messages.push({role:"tool",content:JSON.stringify({error:message}),tool_call_id:call.id});
          }

          if(toolSucceeded && MUTATING_TOOLS.has(call.name) && consecutiveVerifyFailures<MAX_CONSECUTIVE_VERIFY_FAILURES){
            const browserRuntime=shouldRunBrowserRuntime(call.name,call.arguments);
            const verified=await runVerification(browserRuntime);
            if(verified){
              consecutiveVerifyFailures=0;
            }else{
              consecutiveVerifyFailures++;
            }
          }
        }
      }
      throw new Error("Agent step limit reached");
    }catch(error){emit({type:"run.failed",runId,error:error instanceof Error?error.message:String(error)});}
  }
}
