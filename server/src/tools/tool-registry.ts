import type { ToolDefinition } from "../types.js";
import { registerTool,getTool,listRegisteredTools } from "./tool-store.js";
import { toProviderToolDefinitions } from "./tool-definitions.js";

export { registerTool,getTool };

export function listTools(){
  return listRegisteredTools().map(({name,description})=>({name,description}));
}

export function getToolDefinitions(){
  return toProviderToolDefinitions(listRegisteredTools());
}
