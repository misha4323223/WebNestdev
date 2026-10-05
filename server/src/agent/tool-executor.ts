import { getTool } from "../tool-registry.js";
import type { ProviderToolCall } from "../provider.js";
import type { AgentContext } from "./types.js";

export async function executeTool(call:ProviderToolCall,context:AgentContext){
  const tool=getTool(call.name);
  if(!tool)throw new Error("Unknown tool: "+call.name);
  return tool.execute(call.arguments,{projectId:context.request.projectId,runId:context.runId});
}
