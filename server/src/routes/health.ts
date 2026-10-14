import type { FastifyInstance } from "fastify";
import { sandboxStatus } from "../docker-sandbox.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { runQueueStats } from "../agent/run-limiter.js";
import { sandboxQueueStats } from "../sandbox/sandbox-limiter.js";
import { browserQueueStats } from "../tools/browser-limiter.js";
import { liveRuntimePreviews, liveStaticPreviews, runtimePreviewLimit } from "../preview/preview-limiter.js";
import { DEFAULT_CHARS_PER_TOKEN,contextBudgetTokens } from "../agent/context-budget.js";
import { sandboxHostRootDir,sandboxRootDir } from "../sandbox/config.js";
import { lastSandboxMountCheck } from "../sandbox/sandbox-check.js";
import { diskStatus, memoryStatus } from "../health/host-metrics.js";

async function dependencyStatus(){
  const sandbox=await sandboxStatus();
  const mode: "json"|"ydb"|"postgres" = isYdbEnabled() ? "postgres" : "json";
  let storage:{mode:string;ok:boolean}={mode,ok:true};
  if(isYdbEnabled()){
    try{await ydbQuery()`SELECT 1 AS ok`;}catch{storage={mode,ok:false};}
  }
  return {
    storage,
    // Пути и последняя проверка монтирования. Без них расхождение «сервер пишет в один
    // каталог, контейнеры монтируют другой» выглядит как жалоба агента на пропавшие файлы,
    // а не как ошибка выкатки с понятным исправлением.
    sandbox:{...sandbox,sandboxDir:sandboxRootDir(),sandboxHostDir:sandboxHostRootDir(),mount:lastSandboxMountCheck()},
  };
}

/**
 * What the host is doing right now — the same numbers the launch checklist tells an operator to
 * watch, in one place, so nobody has to guess why a preview or a run is waiting:
 *
 * - the three queues (conversations, sandbox containers, Chromium) with what is running, what is
 *   waiting and what the limit is;
 * - how many previews are alive per kind, because a static preview is a listener (~0.5 MB) and a
 *   runtime preview is a container, and only the second one has a cap;
 * - disk and memory, because those are what actually run out first.
 */
async function activity(){
  return {
    runs: runQueueStats(),
    sandbox: sandboxQueueStats(),
    browser: browserQueueStats(),
    previews: {
      runtime: liveRuntimePreviews().length,
      runtimeLimit: runtimePreviewLimit(),
      static: liveStaticPreviews().length,
    },
    // Сколько контекста уходит модели за один шаг: без этого числа отказ провайдера по размеру
    // промпта выглядит необъяснимым (agent/context-budget.ts).
    context: { budgetTokens: contextBudgetTokens(), charsPerToken: DEFAULT_CHARS_PER_TOKEN },
    disk: await diskStatus(sandboxRootDir()),
    memory: await memoryStatus(),
  };
}

export async function registerHealthRoutes(app:FastifyInstance){
  app.get("/api/health",async()=>({
    ok:true,
    service:"webnestdev-server",
    ...(await dependencyStatus()),
    activity:await activity(),
  }));
  app.get("/api/ready",async(_request,reply)=>{
    const dependencies=await dependencyStatus();
    // Расхождение путей песочницы — не временная неисправность хоста, а сломанная выкатка:
    // агент пишет файлы, которых не видит терминал. Готовность обязана об этом сказать.
    const ok=dependencies.storage.ok && dependencies.sandbox.available && dependencies.sandbox.mount?.reason!=="mismatch";
    return reply.code(ok?200:503).send({ok,service:"webnestdev-server",...dependencies,activity:await activity()});
  });
  app.get("/api/sandbox/status",async()=>sandboxStatus());
}
