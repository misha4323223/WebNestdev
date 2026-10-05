import type { ToolDefinition } from "../types.js";

export function toProviderToolDefinitions(tools:ToolDefinition[]){
  return tools.map(({name,description})=>({type:"function",function:{name,description,parameters:{type:"object",additionalProperties:true}}}));
}
