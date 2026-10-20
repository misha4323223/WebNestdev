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
  if(!tool){
    // The one place this is visible: a run that reports a "missing" capability the platform never
    // had is a guessed tool name, and the name is what the next fix needs.
    console.error("[agent] модель вызвала неизвестный инструмент: "+call.name);
    throw new Error("Неизвестный инструмент: "+call.name+". Доступные инструменты: "+toolNames().join(", "));
  }
  const handler=tool.execute??tool.async;
  if(!handler)throw new Error("У инструмента нет обработчика: "+call.name);
  // Снимок — такая же браузерная проверка, как runtime и сценарий: она запускает Chromium и
  // расходует ту же дневную единицу, иначе лимит обходится одним вызовом browser.screenshot.
  if(call.name==="browser.runtime"||call.name==="browser.scenario"||call.name==="browser.screenshot"){
    await consumeUsageForCurrentPlan(context.request.userId,"browserChecks");
  }
  if(storagePreCheckTools.has(call.name)){
    await assertWithinCurrentPlan(context.request.userId);
  }
  // Разговоры с пользователем (модальное окно секретов) идут через тот же поток событий запуска,
  // а остановка запуска передаётся внутрь инструмента, чтобы ожидание закрылось вместе с ним.
  // Поиск в интернете разрешён только при включённом переключателе в панели ввода: флаг читается
  // здесь, поэтому его видят и web.search, и web.read, и ни один из них не обходит решение человека.
  const result=await handler(call.arguments,{projectId:context.request.projectId,runId:context.runId,userId:context.request.userId,...(context.request.conversationId?{conversationId:context.request.conversationId}:{}),emit:context.emit,webSearchEnabled:context.request.webSearch===true,...(context.signal?{signal:context.signal}:{})});
  if(storagePostRecordTools.has(call.name)){
    await recordStorageMutation(context.request.projectId, context.request.userId, {
      heavy: heavyStorageMutationTools.has(call.name),
    });
  }
  return result;
}
