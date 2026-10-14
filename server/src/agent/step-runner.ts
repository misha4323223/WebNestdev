import type { ChatMessage } from "../types.js";
import type { Provider,ProviderToolCall } from "../provider.js";
import { getToolDefinitions } from "../tool-registry.js";
import { ContextBudgetError,calibrateCharsPerToken,estimateTokens,trimMessagesToBudget } from "./context-budget.js";
import { ProviderHttpError,describeProviderFailure } from "../provider/provider-errors.js";
import type { AgentContext } from "./types.js";

export type StepUsage={promptTokens:number;completionTokens:number;estimated:boolean};
export type StepResult={text:string;reasoning:string;calls:ProviderToolCall[];usage:StepUsage};

/** Rough fallback for providers that do not report streaming usage. */
const estimateTokensOfText=(text:string)=>Math.max(1,Math.ceil(text.length/4));

export async function runAgentStep(provider:Provider,messages:ChatMessage[],model:string,context:AgentContext):Promise<StepResult>{
  let text="";let reasoning="";const calls:ProviderToolCall[]=[];let reported:StepUsage|null=null;
  for await(const chunk of provider.stream(messages,model,getToolDefinitions(),context.signal)){
    if(context.signal?.aborted)throw new Error("Запуск агента отменён");
    if(chunk.type==="text"){text+=chunk.text;context.emit({type:"message.delta",runId:context.runId,delta:chunk.text});}
    else if(chunk.type==="reasoning"){reasoning+=chunk.text;context.emit({type:"reasoning.delta",runId:context.runId,delta:chunk.text});}
    else if(chunk.type==="tool_call")calls.push(chunk.call);
    else if(chunk.type==="usage")reported={promptTokens:chunk.promptTokens,completionTokens:chunk.completionTokens,estimated:false};
  }
  const usage:StepUsage=reported??{
    promptTokens:estimateTokens(messages),
    completionTokens:estimateTokensOfText(text+JSON.stringify(calls)),
    estimated:true
  };
  return {text,reasoning,calls,usage};
}

/** How much of the model's window this run is allowed to use, and how characters map to tokens. */
export type StepBudget={budgetTokens:number;charsPerToken:number};

export type BudgetedStep={result:StepResult;messages:ChatMessage[];budget:StepBudget;estimatedTokens:number};

/**
 * The tool schemas are part of every request, and they are not small: a dozen tools with real
 * parameter schemas are tens of kilobytes. Leaving them out of the estimate is exactly how a
 * "120000 token" budget sent the gateway a 932489-token prompt.
 */
export function toolDefinitionChars(){
  try{return JSON.stringify(getToolDefinitions()).length}catch{return 0}
}

/**
 * One step of the model, with the context bounded on every call.
 *
 * The messages this run builds grow step by step — tool output is appended as it arrives — while the
 * model always receives the whole list, so the size has to be decided here rather than once at the
 * start. Two things can go wrong and both are handled here instead of in the run loop:
 *
 * - the running estimate is optimistic: the provider's own `prompt_tokens` calibrates it after every
 *   step, and a prompt that turns out to be larger than the budget shrinks the budget for the next one;
 * - the provider refuses the request as too large: the budget is halved, the conversation is trimmed
 *   again — closest history kept — and the step is retried exactly once. A second refusal becomes a
 *   `ContextBudgetError` with both numbers, which is a sentence the user can act on, not a 400 body.
 */
export async function runBudgetedStep(
  provider:Provider,
  messages:ChatMessage[],
  model:string,
  context:AgentContext,
  budget:StepBudget,
  hooks:{onPrepared?:(prepared:{tokens:number;budgetTokens:number})=>void}={},
):Promise<BudgetedStep>{
  let current:StepBudget={...budget};
  const overheadChars=toolDefinitionChars();
  const trim=(list:ChatMessage[],keepRecent?:number)=>trimMessagesToBudget(list,{budgetTokens:current.budgetTokens,charsPerToken:current.charsPerToken,overheadChars,...(keepRecent?{keepRecent}:{})});
  let prepared=trim(messages);
  hooks.onPrepared?.({tokens:prepared.report.estimatedTokens,budgetTokens:current.budgetTokens});

  for(let attempt=0;attempt<2;attempt++){
    try{
      const result=await runAgentStep(provider,prepared.messages,model,context);
      if(!result.usage.estimated&&result.usage.promptTokens>0){
        // The provider counted the real prompt, so it says how many characters a token really is.
        current.charsPerToken=calibrateCharsPerToken(prepared.report.chars,result.usage.promptTokens);
        // A prompt larger than the budget means the estimate was still optimistic. The budget stays
        // the ceiling — it is never raised — while the calibration makes the next trim send less.
        if(result.usage.promptTokens>current.budgetTokens)current.budgetTokens=Math.max(4_000,Math.min(current.budgetTokens,result.usage.promptTokens));
      }
      return {result,messages:prepared.messages,budget:current,estimatedTokens:prepared.report.estimatedTokens};
    }catch(error){
      if(!(error instanceof ProviderHttpError)||error.code!=="CONTEXT_OVERFLOW")throw error;
      if(attempt>0)throw new ContextBudgetError(error.inputTokens??estimateTokens(prepared.messages,current.charsPerToken),error.limitTokens??current.budgetTokens);
      console.error("[agent] провайдер отказал по размеру контекста, сокращаю и повторяю шаг: "+describeProviderFailure(error));
      current.budgetTokens=Math.max(4_000,Math.min(Math.floor(current.budgetTokens/2),Math.floor((error.limitTokens??current.budgetTokens)*0.7)));
      prepared=trim(prepared.messages,4);
      hooks.onPrepared?.({tokens:prepared.report.estimatedTokens,budgetTokens:current.budgetTokens});
    }
  }
  throw new ContextBudgetError(estimateTokens(prepared.messages,current.charsPerToken),current.budgetTokens);
}
