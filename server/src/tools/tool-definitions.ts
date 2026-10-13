import type { ToolDefinition } from "../types.js";

export function toProviderToolDefinitions(tools:ToolDefinition[]){
  return tools.map(({name,description,parameters})=>({type:"function",function:{name,description,parameters:parameters??{type:"object",additionalProperties:true}}}));
}
