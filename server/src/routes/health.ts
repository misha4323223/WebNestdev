import type { FastifyInstance } from "fastify";
import { sandboxStatus } from "../docker-sandbox.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { runQueueStats } from "../agent/run-limiter.js";
import { sandboxQueueStats } from "../sandbox/sandbox-limiter.js";
import { browserQueueStats } from "../tools/browser-limiter.js";
import { liveRuntimePreviews, liveStaticPreviews, runtimePreviewLimit } from "../preview/preview-limiter.js";
import { previewAddresses } from "../preview/preview-store.js";
import { DEFAULT_CHARS_PER_TOKEN,contextBudgetTokens,contextMaxMessages } from "../agent/context-budget.js";
import { sandboxHostRootDir,sandboxRootDir } from "../sandbox/config.js";
import { lastSandboxMountCheck } from "../sandbox/sandbox-check.js";
import { diskStatus, memoryStatus } from "../health/host-metrics.js";
import { smsReadiness, smsSummary } from "../auth/sms.js";

/**
 * Какая сборка работает на сервере. Значение запекается в образ при выкатке
 * (WEBNESTDEV_BUILD передаёт workflow), и это единственный честный ответ на вопрос,
 * который иначе превращается в догадки: та ли версия сейчас в проде, которую только
 * что выкатили, или ВМ осталась на предыдущей. Браузер с закешированным документом
 * тоже проверяется по этому числу — если оно новое, а вид старый, дело в кеше,
 * а не в выкатке.
 */
function buildId() {
  return process.env.WEBNESTDEV_BUILD?.trim() || "dev";
}

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
      // Адреса живых предпросмотров: `settled` — этот адрес подтверждён запросом самого сервера,
      // то есть приложение видно и панели, и Chromium. `settled: false` у работающего предпросмотра
      // — это ответ на «предпросмотр запущен, а в панели белый экран», который иначе искали бы
      // только на ВМ (см. preview/preview-address.ts).
      addresses: previewAddresses(),
    },
    // Сколько контекста уходит модели за один шаг: без этого числа отказ провайдера по размеру
    // промпта выглядит необъяснимым (agent/context-budget.ts).
    // `charsPerTokenDefault` — стартовая оценка: во время запуска она уточняется по отчёту
    // провайдера (см. `run.progress.tokens`), поэтому здесь честно только значение по умолчанию.
    context: { budgetTokens: contextBudgetTokens(), maxMessages: contextMaxMessages(), charsPerTokenDefault: DEFAULT_CHARS_PER_TOKEN },
    disk: await diskStatus(sandboxRootDir()),
    memory: await memoryStatus(),
  };
}

/**
 * Состояние SMS для /api/health: провайдер, тестовый режим, способ аутентификации и —
 * главное — читается ли выбранный ключ. Без последнего «ключ задан» было неотличимо от
 * «ключ не читается», и об этом узнавали только по отказу отправки.
 */
async function smsInfo(){
  const readiness=await smsReadiness();
  return {
    ...smsSummary(),
    ready:readiness.ready,
    // Каким путём прочитан ключ сервисного аккаунта: /app/… в переменной и файл в каталоге
    // секретов — разные вещи, и именно это различие решает, уходят SMS или нет.
    ...(readiness.keyFile===undefined?{}:{keyFile:readiness.keyFile}),
    ...(readiness.note===undefined?{}:{note:readiness.note}),
    ...(readiness.problem===undefined?{}:{problem:readiness.problem}),
  };
}

export async function registerHealthRoutes(app:FastifyInstance){
  app.get("/api/health",async()=>({
    ok:true,
    service:"webnestdev-server",
    build:buildId(),
    ...(await dependencyStatus()),
    // Настроен ли вход по SMS на самом деле: провайдер по имени и способ аутентификации.
    // Секретов здесь нет, зато «SMS перестали приходить» проверяется одной командой
    // curl localhost:8787/api/health вместо чтения .env на ВМ.
    sms:await smsInfo(),
    activity:await activity(),
  }));
  app.get("/api/ready",async(_request,reply)=>{
    const dependencies=await dependencyStatus();
    // Расхождение путей песочницы — не временная неисправность хоста, а сломанная выкатка:
    // агент пишет файлы, которых не видит терминал. Готовность обязана об этом сказать.
    const ok=dependencies.storage.ok && dependencies.sandbox.available && dependencies.sandbox.mount?.reason!=="mismatch";
    return reply.code(ok?200:503).send({ok,service:"webnestdev-server",build:buildId(),...dependencies,sms:await smsInfo(),activity:await activity()});
  });
  app.get("/api/sandbox/status",async()=>sandboxStatus());
}
