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
import { planQaScenario } from "./qa/scenario-planner.js";

const MAX_CONSECUTIVE_VERIFY_FAILURES=3;
const MUTATING_TOOLS=new Set(["fs.write","fs.rename","fs.delete","terminal.exec","npm.install"]);

type CommandResultLike={ok?:unknown;exitCode?:unknown;signal?:unknown};
function commandSucceeded(output:unknown){
  if(typeof output!=="object"||output===null)return false;
  const result=output as CommandResultLike;
  return result.ok===true&&result.exitCode===0&&result.signal==null;
}

function routeFromMutation(name:string,args:Record<string,unknown>){
  if(name!=="fs.write"&&name!=="fs.rename")return "/";
  const value=typeof args.path==="string"?args.path:typeof args.to==="string"?args.to:"";
  const normalized=value.replace(/^\\.\\//,"").replace(/\\.(tsx?|jsx?|html?)$/i,"");
  const page=normalized.match(/(?:^|\\/)pages\\/(.+)$/i)?.[1]??normalized.match(/(?:^|\\/)app\\/(.+?)(?:\\/page)?$/i)?.[1];
  if(!page)return "/";
  const route="/"+page.replace(/\\/index$/i,"").replace(/\\[(?:[^\\]]+)\\]/g,":param");
  return route==="/"?"/":route.replace(/\\/+/g,"/");
}

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
      let consecutiveScenarioFailures=0;
      let verificationPending=false;
      let scenarioPending=false;

      const runVerification=async (browserRuntime:boolean,routes:string[])=>{
        const verifyCalls=[
          {id:randomUUID(),name:"terminal.exec",arguments:{command:"npm run build"}},
          {id:randomUUID(),name:"preview.start",arguments:{}},
          {id:randomUUID(),name:"project.verify",arguments:{path:routes[0]??"/"}},
          ...(browserRuntime?routes.map(path=>({id:randomUUID(),name:"browser.runtime",arguments:{path}})):[]),
        ];
        const qa={build:false,preview:false,ssr:false,browser:browserRuntime?false:true};
        for(const verifyCall of verifyCalls){
          if(signal?.aborted)throw new Error("Agent run cancelled");
          emit({type:"tool.started",runId,toolCallId:verifyCall.id,name:verifyCall.name,input:verifyCall.arguments});
          try{
            const output=await executeTool(verifyCall as any,{runId,request,emit,signal});
            emit({type:"tool.finished",runId,toolCallId:verifyCall.id,name:verifyCall.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:verifyCall.id});
            if(verifyCall.name==="terminal.exec"){
              qa.build=commandSucceeded(output);
              if(!qa.build)return false;
            }
            if(verifyCall.name==="preview.start"){
              qa.preview=Boolean((output as {running?:boolean;ok?:boolean}).running??(output as {ok?:boolean}).ok);
              if(!qa.preview)return false;
            }
            if(verifyCall.name==="project.verify"){
              qa.ssr=Boolean((output as {ok?:boolean}).ok);
              if(!qa.ssr)return false;
            }
            if(verifyCall.name==="browser.runtime"){
              qa.browser=Boolean((output as {ok?:boolean}).ok);
              if(!qa.browser)return false;
            }
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            const output={ok:false,error:message};
            emit({type:"tool.finished",runId,toolCallId:verifyCall.id,name:verifyCall.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:verifyCall.id});
            return false;
          }
        }
        messages.push({role:"system",content:"QA VERIFICATION PASSED: BUILD=PASS, PREVIEW=PASS, SSR=PASS"+(browserRuntime?", BROWSER=PASS":"")});
        return true;
      };

      for(let step=0;step<maxSteps;step++){
        if(signal?.aborted)throw new Error("Agent run cancelled");
        emit({type:"run.progress",runId,step:step+1,maxSteps});
        const context={runId,request,emit,signal};
        const result=await runAgentStep(provider,messages,model,context);

        if(!result.calls.length){
          if(verificationPending||scenarioPending){
            if(consecutiveVerifyFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES){
              throw new Error("Verification failed repeatedly; maximum verification attempts reached");
            }
            messages.push({
              role:"system",
              content:scenarioPending
              ? "The user-visible change passed build, preview, SSR and browser smoke verification, but Browser QA is still pending. You MUST call browser.scenario now. Derive the shortest meaningful end-to-end user flow from the original task and the changed route, using at most 20 steps. If the scenario fails, inspect its diagnostics, fix the smallest necessary issue, and run the scenario again. Do not finish the task until browser.scenario returns ok=true."
              : "The requested change is not verified yet. Do not finish the task. Inspect the latest verification diagnostic, make the smallest necessary fix, and run the verification again. A successful tool call is not sufficient proof of completion.",
            });
            continue;
          }

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

        let mutationSucceeded=false;
        let browserRuntimeRequired=false;
        const verificationRoutes=new Set<string>();

        for(const call of result.calls){
          if(signal?.aborted)throw new Error("Agent run cancelled");
          emit({type:"tool.started",runId,toolCallId:call.id,name:call.name,input:call.arguments});
          try{
            const output=await executeTool(call,context);
            if(signal?.aborted)throw new Error("Agent run cancelled");
            emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output});
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:call.id});

            if(call.name==="browser.scenario"){
              if((output as {ok?:boolean}).ok===true){
                scenarioPending=false;
                consecutiveScenarioFailures=0;
                messages.push({role:"system",content:"BROWSER QA SCENARIO PASSED: user-visible flow completed successfully with no browser console, page, HTTP, or network errors."});
              }else{
                scenarioPending=true;
                consecutiveScenarioFailures++;
                if(consecutiveScenarioFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES){
                  throw new Error("Browser QA scenario failed repeatedly; maximum scenario attempts reached");
                }
              }
            }

            if(call.name==="project.verify"||call.name==="browser.runtime"){
              if((output as {ok?:boolean}).ok===true){
                verificationPending=false;
                consecutiveVerifyFailures=0;
              }else{
                verificationPending=true;
                consecutiveVerifyFailures++;
              }
            }

            if(MUTATING_TOOLS.has(call.name)){
              mutationSucceeded=true;
              browserRuntimeRequired=browserRuntimeRequired||shouldRunBrowserRuntime(call.name,call.arguments);
              verificationRoutes.add(routeFromMutation(call.name,call.arguments));
            }
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output:{error:message}});
            messages.push({role:"tool",content:JSON.stringify({error:message}),tool_call_id:call.id});
          }
        }

        if(mutationSucceeded){
          verificationPending=true;
          const verified=await runVerification(browserRuntimeRequired,[...verificationRoutes]);
          if(verified){
            consecutiveVerifyFailures=0;
            verificationPending=false;
            if(browserRuntimeRequired){
              scenarioPending=true;
              consecutiveScenarioFailures=0;
              const affectedRoute=[...verificationRoutes][0]??"/";
              const plannedScenario=planQaScenario(task,affectedRoute);
              const scenarioCall={id:randomUUID(),name:"browser.scenario",arguments:plannedScenario};
              emit({type:"tool.started",runId,toolCallId:scenarioCall.id,name:scenarioCall.name,input:scenarioCall.arguments});
              try{
                const scenarioOutput=await executeTool(scenarioCall as any,{runId,request,emit,signal});
                emit({type:"tool.finished",runId,toolCallId:scenarioCall.id,name:scenarioCall.name,output:scenarioOutput});
                messages.push({role:"tool",content:JSON.stringify(scenarioOutput),tool_call_id:scenarioCall.id});
                if((scenarioOutput as {ok?:boolean}).ok===true){
                  scenarioPending=false;
                  consecutiveScenarioFailures=0;
                  messages.push({role:"system",content:"BROWSER QA SCENARIO PASSED: the automatically planned user flow passed in Chromium with no browser console, page, HTTP, or network errors."});
                }else{
                  scenarioPending=true;
                  consecutiveScenarioFailures++;
                  messages.push({role:"system",content:"AUTOMATIC BROWSER QA FAILED. Inspect the scenario diagnostics and failure screenshot, fix the smallest necessary issue, then repeat verification. Do not finish while Browser QA is pending."});
                  if(consecutiveScenarioFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES) throw new Error("Browser QA scenario failed repeatedly; maximum scenario attempts reached");
                }
              }catch(error){
                const message=error instanceof Error?error.message:String(error);
                scenarioPending=true;
                consecutiveScenarioFailures++;
                emit({type:"tool.finished",runId,toolCallId:scenarioCall.id,name:scenarioCall.name,output:{ok:false,error:message}});
                messages.push({role:"tool",content:JSON.stringify({ok:false,error:message}),tool_call_id:scenarioCall.id});
                if(consecutiveScenarioFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES) throw new Error("Browser QA scenario failed repeatedly; maximum scenario attempts reached");
              }
            }else{
              scenarioPending=false;
            }
          }else{
            consecutiveVerifyFailures++;
            verificationPending=true;
            if(consecutiveVerifyFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES){
              throw new Error("Verification failed repeatedly; maximum verification attempts reached");
            }
          }
        }
      }

      if(verificationPending)throw new Error("Agent step limit reached with unverified changes");
      if(scenarioPending)throw new Error("Agent step limit reached with pending Browser QA scenario");
      throw new Error("Agent step limit reached");
    }catch(error){emit({type:"run.failed",runId,error:error instanceof Error?error.message:String(error)});}
  }
}
