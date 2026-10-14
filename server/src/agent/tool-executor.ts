import { getTool,toolNames } from "../tool-registry.js";
import type { ProviderToolCall } from "../provider.js";
import type { AgentContext } from "./types.js";
import { consumeUsageForCurrentPlan } from "../account/usage-store.js";
import { assertWithinCurrentPlan, recordStorageMutation } from "../account/storage-quota.js";

const storagePreCheckTools = new Set(["fs.write", "terminal.exec", "npm.install"]);
const storagePostRecordTools = new Set([
  "fs.write",
  "fs.delete",
  "fs.rename",
  "terminal.exec",
  "npm.install",
  "git.add",
  "git.commit",
]);
const heavyStorageMutationTools = new Set(["terminal.exec", "npm.install"]);

export async function executeTool(call:ProviderToolCall,context:AgentContext){
  const tool=getTool(call.name);
  // The list is what turns a wrong tool name into a corrected next step instead of a dead end —
  // a model that guessed a tool name (and told the user it was "unavailable") can pick a real one.
  if(!tool)throw new Error("Неизвестный инструмент: "+call.name+". Доступные инструменты: "+toolNames().join(", "));
  const handler=tool.execute??tool.async;
  if(!handler)throw new Error("У инструмента нет обработчика: "+call.name);
  if(call.name==="browser.runtime"||call.name==="browser.scenario"){
    await consumeUsageForCurrentPlan(context.request.userId,"browserChecks");
  }
  if(storagePreCheckTools.has(call.name)){
    await assertWithinCurrentPlan(context.request.userId);
  }
  const result=await handler(call.arguments,{projectId:context.request.projectId,runId:context.runId,userId:context.request.userId});
  if(storagePostRecordTools.has(call.name)){
    await recordStorageMutation(context.request.projectId, context.request.userId, {
      heavy: heavyStorageMutationTools.has(call.name),
    });
  }
  return result;
}
