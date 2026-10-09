import { getTool } from "../tool-registry.js";
import type { ProviderToolCall } from "../provider.js";
import type { AgentContext } from "./types.js";
import { consumeUsageForCurrentPlan } from "../account/usage-store.js";
export async function executeTool(call:ProviderToolCall,context:AgentContext){
  const tool=getTool(call.name);
  if(!tool)throw new Error("Unknown tool: "+call.name);
  const handler=tool.execute??tool.async;
  if(!handler)throw new Error("Tool has no executable handler: "+call.name);
  if(call.name==="browser.runtime"||call.name==="browser.scenario"){
    await consumeUsageForCurrentPlan(context.request.userId,"browserChecks");
  }
  return handler(call.arguments,{projectId:context.request.projectId,runId:context.runId,userId:context.request.userId});
}
