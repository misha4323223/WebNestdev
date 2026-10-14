import { randomUUID } from "node:crypto";
import type { AgentRunRequest,ChatMessage,PlanState } from "./types.js";
import { createProvider } from "./provider.js";
import { appendConversationMessages,getConversation,getProject,getProjectProvider,saveConversationPlan } from "./project-store.js";
import { buildInitialMessages } from "./agent/message-builder.js";
import { buildProjectContext } from "./agent/context-builder.js";
import { retrieveRelevantFiles } from "./agent/context-retrieval.js";
import { executeTool } from "./agent/tool-executor.js";
import { runAgentStep } from "./agent/step-runner.js";
import type { EventSink } from "./agent/types.js";
import { planQaScenario } from "./qa/scenario-planner.js";
import { analyzeChangedFiles } from "./qa/diff-analyzer.js";
import { parseChangedSource, type ParsedChange } from "./qa/change-parser.js";

/**
 * Tools that change the project and therefore trigger the automatic verification cycle.
 * `database.env` writes the project's connection string, so it belongs here too.
 */
const MUTATING_TOOLS=new Set(["fs.write","fs.rename","fs.delete","terminal.exec","npm.install","database.env"]);
const MAX_CONSECUTIVE_VERIFY_FAILURES=3;
/** Git bookkeeping changes the repository, not the code, so it is not verified. */
const PLANNER_FORBIDDEN_TOOLS=new Set(["git.add","git.commit"]);

/**
 * Planner mode still has to read the project, so plain inspection commands are allowed
 * while everything that writes is refused. Anything chained or piped is refused too:
 * one command, one answer, with no room for a write hidden behind a pipe.
 */
const READ_ONLY_COMMANDS=new Set(["ls","cat","head","tail","wc","find","grep","rg","tree","pwd","file","stat","du","df","which","whereis","echo","jq","diff","sort","uniq","cut","basename","dirname","realpath","sed","awk","git","npm","node","tsc","eslint","prettier"]);
const WRITE_MARKERS=[">","tee ","sed -i","perl -i","--in-place","--write","--fix","rm ","rmdir ","mv ","cp ","mkdir ","touch ","truncate ","chmod ","chown ","ln ","dd ","patch ","git add","git commit","git push","git checkout","git switch","git restore","git reset","git clean","git stash","git merge","git rebase","git rm","git mv","npm i ","npm install","npm ci","npm run","npm exec","yarn add","pnpm add","bun add","bun run","pip install","python -c","node -e","node --eval","curl ","wget ","ssh ","scp ","sudo ","kill ","systemctl ","docker "];

function isReadOnlyCommand(command:string){
  const value=command.trim();
  if(!value)return false;
  if(/[;&|]/.test(value))return false;
  if(WRITE_MARKERS.some(marker=>value.includes(marker)))return false;
  return READ_ONLY_COMMANDS.has(value.split(/\s+/)[0].replace(/^.*\//,""));
}

/**
 * Planner mode is read-only, so any call that changes something is refused. Two tool
 * families depend on the input: yandex.request reads with GET/HEAD and changes the
 * account with every other method, and terminal.exec only inspects when the command is
 * on the read-only list.
 */
export function changesSomething(name:string,input:unknown){
  if(name==="terminal.exec"){
    const command=(input as {command?:unknown}|null)?.command;
    return typeof command!=="string"||!isReadOnlyCommand(command);
  }
  if(MUTATING_TOOLS.has(name)||PLANNER_FORBIDDEN_TOOLS.has(name))return true;
  if(name!=="yandex.request")return false;
  const method=(input as {method?:unknown}|null)?.method;
  if(typeof method!=="string")return false;
  return method.toUpperCase()!=="GET"&&method.toUpperCase()!=="HEAD";
}

import { commandSucceeded, routeFromMutation, shouldRunBrowserRuntime } from "./agent/verification-policy.js";
import { getPlatformProviderConfig } from "./provider/platform-provider.js";
import { recordRunUsage } from "./account/usage-store.js";


export class AgentRuntime {
  async run(request:AgentRunRequest,emit:EventSink,signal?:AbortSignal){
    const runId=randomUUID(); emit({type:"run.started",runId});
    const usageTotals={promptTokens:0,completionTokens:0,estimated:false};
    let usageModel="";
    try{
      const project=await getProject(request.projectId);
      if(!project||project.userId!==request.userId)throw new Error("Проект не найден");
      const config=await getProjectProvider(request.projectId);
      const platformConfig=getPlatformProviderConfig();
      const provider=createProvider(config??platformConfig??undefined);
      const projectContext=await buildProjectContext(project,request.userId);
      const task=request.messages.filter(message=>message.role==="user").at(-1)?.content??"";
      const relevantFiles=await retrieveRelevantFiles(request.projectId,request.userId,task);
      const mode=request.mode==="planner"?"planner":"developer";
      const messages:ChatMessage[]=buildInitialMessages(request.messages,projectContext+"\n\nTASK-RELEVANT SOURCE FILES\n"+relevantFiles,mode);
      const model=request.model??config?.model??(config?undefined:platformConfig?.model);
      if(!model)throw new Error("Модель AI не настроена");
      usageModel=model;
      const maxSteps=Math.min(50,Math.max(1,Number(process.env.AGENT_MAX_STEPS??20)));
      let consecutiveVerifyFailures=0;
      let consecutiveScenarioFailures=0;
      let verificationPending=false;
      let scenarioPending=false;
      // The plan is what the user watches during a long run, so it is tracked per run.
      let planSeen=false;
      let planNudged=false;
      const changedFiles=new Set<string>();
      const parsedChanges:ParsedChange[]=[];

      /**
       * Everything the user can see — the answers, the thinking behind them and every
       * action with its result — belongs to the conversation, so it is written there as
       * it happens. A reload, a switched tab or a closed window loses nothing.
       */
      const persist=async (entries:ChatMessage[])=>{
        if(!request.conversationId||!entries.length)return;
        try{
          const conversation=await getConversation(request.conversationId);
          if(!conversation||conversation.projectId!==request.projectId)throw new Error("Сессия не найдена в этом проекте");
          await appendConversationMessages(request.conversationId,entries);
        }catch(error){console.error("Failed to persist conversation messages",error);}
      };
      const finishTool=async (call:{id:string;name:string},output:unknown)=>{
        emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output});
        await persist([{role:"tool",content:JSON.stringify(output??null),tool_call_id:call.id}]);
      };

      const runVerification=async (browserRuntime:boolean,routes:string[])=>{
        const verifyCalls=[
          {id:randomUUID(),name:"terminal.exec",arguments:{command:"npm run build"}},
          {id:randomUUID(),name:"preview.start",arguments:{}},
          {id:randomUUID(),name:"project.verify",arguments:{path:routes[0]??"/"}},
          ...(browserRuntime?routes.map(path=>({id:randomUUID(),name:"browser.runtime",arguments:{path}})):[]),
        ];
        const qa={build:false,preview:false,ssr:false,browser:browserRuntime?false:true};
        for(const verifyCall of verifyCalls){
          if(signal?.aborted)throw new Error("Запуск агента отменён");
          emit({type:"tool.started",runId,toolCallId:verifyCall.id,name:verifyCall.name,input:verifyCall.arguments});
          try{
            const output=await executeTool(verifyCall as any,{runId,request,emit,signal});
            await finishTool(verifyCall,output);
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
            await finishTool(verifyCall,output);
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:verifyCall.id});
            return false;
          }
        }
        messages.push({role:"system",content:"QA VERIFICATION PASSED: BUILD=PASS, PREVIEW=PASS, SSR=PASS"+(browserRuntime?", BROWSER=PASS":"")});
        return true;
      };

      for(let step=0;step<maxSteps;step++){
        if(signal?.aborted)throw new Error("Запуск агента отменён");
        emit({type:"run.progress",runId,step:step+1,maxSteps});
        const context={runId,request,emit,signal};
        const result=await runAgentStep(provider,messages,model,context);
        usageTotals.promptTokens+=result.usage.promptTokens;
        usageTotals.completionTokens+=result.usage.completionTokens;
        usageTotals.estimated=usageTotals.estimated||result.usage.estimated;

        if(!result.calls.length){
          if(verificationPending||scenarioPending){
            if(consecutiveVerifyFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES){
              throw new Error("Проверка не прошла несколько раз подряд — достигнут предел попыток проверки");
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
          await persist([{role:"assistant",content:text,...(result.reasoning?{reasoning:result.reasoning}:{})}]);
          emit({type:"run.completed",runId}); return;
        }

        const assistantMessage:ChatMessage={role:"assistant",content:result.text,tool_calls:result.calls,...(result.reasoning?{reasoning:result.reasoning}:{})};
        messages.push(assistantMessage);
        // The assistant turn is part of the user-visible history, so it is persisted as it
        // is produced — with the thinking behind it — and survives a reload mid-run.
        if(result.calls.length||result.text.trim())await persist([assistantMessage]);

        let mutationSucceeded=false;
        let browserRuntimeRequired=false;
        const verificationRoutes=new Set<string>();

        for(const call of result.calls){
          if(signal?.aborted)throw new Error("Запуск агента отменён");
          emit({type:"tool.started",runId,toolCallId:call.id,name:call.name,input:call.arguments});
          // Planner mode is read-only by construction, not just by instruction.
          if(mode==="planner"&&changesSomething(call.name,call.arguments)){
            const refusal={error:"Режим «Планировщик»: изменения отключены. Разрешены только чтение файлов, команды из списка только-для-чтения (без перенаправлений, установки пакетов и git add/commit) и GET/HEAD-запросы. Опишите этот шаг в плане и продолжите изучение проекта.",mode:"planner"};
            await finishTool(call,refusal);
            messages.push({role:"tool",content:JSON.stringify(refusal),tool_call_id:call.id});
            continue;
          }
          try{
            const output=await executeTool(call,context);
            if(signal?.aborted)throw new Error("Запуск агента отменён");
            await finishTool(call,output);
            messages.push({role:"tool",content:JSON.stringify(output),tool_call_id:call.id});

            if(call.name==="plan.update"){
              const plan=(output as {plan?:PlanState}).plan;
              if(plan){
                planSeen=true;
                emit({type:"plan.updated",runId,plan});
                if(request.conversationId){
                  try{await saveConversationPlan(request.conversationId,plan);}
                  catch(error){console.error("Failed to persist the plan",error);}
                }
              }
            }

            if(call.name==="browser.scenario"){
              if((output as {ok?:boolean}).ok===true){
                scenarioPending=false;
                consecutiveScenarioFailures=0;
                messages.push({role:"system",content:"BROWSER QA SCENARIO PASSED: user-visible flow completed successfully with no browser console, page, HTTP, or network errors."});
              }else{
                scenarioPending=true;
                consecutiveScenarioFailures++;
                if(consecutiveScenarioFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES){
                  throw new Error("Сценарий проверки в браузере не прошёл несколько раз подряд — достигнут предел попыток");
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
              const changedPath=typeof call.arguments.path==="string"?call.arguments.path:typeof call.arguments.to==="string"?call.arguments.to:"";
              if(changedPath){
                changedFiles.add(changedPath);
                const source=typeof call.arguments.content==="string"?call.arguments.content:"";
                if(source) parsedChanges.push(...parseChangedSource(changedPath,source).changes);
                const removedChanges=(output as {removedChanges?:ParsedChange[]}).removedChanges;
                if(call.name==="fs.delete"&&Array.isArray(removedChanges)) parsedChanges.push(...removedChanges);
              }
            }
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            await finishTool(call,{error:message});
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
              const changeAnalysis=analyzeChangedFiles([...changedFiles],parsedChanges);
              const plannedScenario=planQaScenario(task,affectedRoute,changeAnalysis.kind,changeAnalysis.confidence,parsedChanges);
              (plannedScenario as Record<string,unknown>).changeAnalysis=changeAnalysis;
              const scenarioCall={id:randomUUID(),name:"browser.scenario",arguments:plannedScenario};
              emit({type:"tool.started",runId,toolCallId:scenarioCall.id,name:scenarioCall.name,input:scenarioCall.arguments});
              try{
                const scenarioOutput=await executeTool(scenarioCall as any,{runId,request,emit,signal});
                await finishTool(scenarioCall,scenarioOutput);
                messages.push({role:"tool",content:JSON.stringify(scenarioOutput),tool_call_id:scenarioCall.id});
                if((scenarioOutput as {ok?:boolean}).ok===true){
                  scenarioPending=false;
                  consecutiveScenarioFailures=0;
                  messages.push({role:"system",content:"BROWSER QA SCENARIO PASSED: the automatically planned user flow passed in Chromium with no browser console, page, HTTP, or network errors."});
                }else{
                  scenarioPending=true;
                  consecutiveScenarioFailures++;
                  messages.push({role:"system",content:"AUTOMATIC BROWSER QA FAILED. Inspect the scenario diagnostics and failure screenshot, fix the smallest necessary issue, then repeat verification. Do not finish while Browser QA is pending."});
                  if(consecutiveScenarioFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES) throw new Error("Сценарий проверки в браузере не прошёл несколько раз подряд — достигнут предел попыток");
                }
              }catch(error){
                const message=error instanceof Error?error.message:String(error);
                scenarioPending=true;
                consecutiveScenarioFailures++;
                await finishTool(scenarioCall,{ok:false,error:message});
                messages.push({role:"tool",content:JSON.stringify({ok:false,error:message}),tool_call_id:scenarioCall.id});
                if(consecutiveScenarioFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES) throw new Error("Сценарий проверки в браузере не прошёл несколько раз подряд — достигнут предел попыток");
              }
            }else{
              scenarioPending=false;
            }
          }else{
            consecutiveVerifyFailures++;
            verificationPending=true;
            if(consecutiveVerifyFailures>=MAX_CONSECUTIVE_VERIFY_FAILURES){
              throw new Error("Проверка не прошла несколько раз подряд — достигнут предел попыток проверки");
            }
          }
        }

        // Asked once per run: a task that already changed files should be visible as a
        // plan. Waiting for the model to remember on its own would make the plan empty.
        if(!planSeen&&!planNudged&&(mutationSucceeded||(mode==="planner"&&step>=1))){
          planNudged=true;
          messages.push({role:"system",content:mode==="planner"
            ? "NO PLAN PUBLISHED YET: in Planner mode the plan is the deliverable. Call plan.update now with the full ordered list of steps and their statuses, so the user can read and confirm it."
            : "NO USER-VISIBLE PLAN YET: this task already changed files, so the user cannot see the remaining steps. Call plan.update now with the complete ordered list of the remaining work, mark exactly one step 'in_progress', and keep the list current until every step is 'done'."});
        }
      }

      if(verificationPending)throw new Error("Достигнут лимит шагов агента, а изменения не проверены");
      if(scenarioPending)throw new Error("Достигнут лимит шагов агента, проверка в браузере не завершена");
      throw new Error("Достигнут лимит шагов агента");
    }catch(error){emit({type:"run.failed",runId,error:error instanceof Error?error.message:String(error)});}
    finally{
      if(usageModel&&usageTotals.promptTokens+usageTotals.completionTokens>0){
        try{
          await recordRunUsage(request.userId,{runId,projectId:request.projectId,conversationId:request.conversationId,model:usageModel,promptTokens:usageTotals.promptTokens,completionTokens:usageTotals.completionTokens,estimated:usageTotals.estimated});
        }catch(error){console.error("Failed to record run usage",error);}
      }
    }
  }
}
