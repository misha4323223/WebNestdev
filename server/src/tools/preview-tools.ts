import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus,previewLogs } from "../preview-manager.js";
import { tailLogLines } from "../preview/log-lines.js";
import { registerTool } from "../tool-registry.js";
import { accountPlanFor } from "../billing/store.js";
import { planAllows } from "../account/entitlements.js";

/**
 * These three take no arguments at all, and the schema says so. Leaving it open (`additionalProperties`
 * unset) invited models to send guesses like `{port:3000}`, and a rejected call costs a whole step.
 */
const NO_ARGUMENTS = { type: "object", additionalProperties: false, properties: {} };

/**
 * The agent only needs readiness, mode and progress. Node/container/host/owner fields are server
 * routing details and must never reach a user-facing answer, so they are dropped here as well as
 * covered by the platform rule in the system prompt.
 */
function previewForAgent(status: Awaited<ReturnType<typeof previewStatus>>) {
  if (!status.running) return status;
  return {
    running: true as const,
    ready: status.ready,
    ...(status.mode ? {mode:status.mode} : {}),
    ...(status.settled === undefined ? {} : {settled:status.settled}),
    startedAt: status.startedAt,
    ...(status.starting ? {starting:status.starting} : {}),
    ...(status.viaExec ? {viaExec:true} : {}),
    ...(status.ownerUnavailable ? {ownerUnavailable:true} : {}),
  };
}

registerTool({
  name:"preview.start",
  description:"Start the platform Preview for this project after creating or updating it. On plans without container preview it builds once and serves static files; on Premium it may use a container/hybrid development runtime. Always use this tool instead of starting a dev server through terminal.exec.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {
    // Агент запускает тот же preview, что и панель. Контейнерный режим — возможность Премиума;
    // статический остаётся доступен на всех тарифах, поэтому решает сам preview-manager.
    const plan=await accountPlanFor(context.userId);
    const allowContainer=planAllows(plan,"containerPreview");
    const allowFunctions=planAllows(plan,"serverlessFunctions");
    return previewForAgent(await startPreview(await getSandbox(context.projectId,context.userId),{allowContainer,allowFunctions}));
  }
});
registerTool({
  name:"preview.stop",
  description:"Stop the project's live preview server.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {await getSandbox(context.projectId,context.userId);return stopPreview(context.projectId)}
});
registerTool({
  name:"preview.status",
  description:"Check whether the project's live preview is running and ready. The result belongs to this project only and contains readiness/progress, not platform routing details; still never describe platform infrastructure to the user.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {await getSandbox(context.projectId,context.userId);return previewForAgent(await previewStatus(context.projectId))}
});

/** Сколько символов лога возвращается модели: хвост ошибки, а не весь вывод запуска. */
const PREVIEW_LOG_MAX_CHARS = 10_000;

registerTool({
  name:"preview.logs",
  description:
    "Read the tail of this project's running Preview output. Input: {lines?:number (1–400, default 120), grep?:string (case-insensitive filter)}. " +
    "This is the same project's runtime, never another project's or a foreign environment. Depending on how the Preview is served, the tail is the dev-server output or the build/startup log followed by the server-side runtime log; a static frontend has no separate runtime process, so its build log is the frontend output. " +
    "Use it when the Preview fails to start, a route returns a server error, or project.verify points to startup logs: the error and the exact command are in this output, not in the page HTML. " +
    "The Preview must be running; start it with preview.start first. Logs are a snapshot: read them after a check, not instead of it. Do not try to inspect the Preview process from terminal.exec; use this tool.",
  parameters:{
    type:"object",
    additionalProperties:false,
    properties:{
      lines:{type:"number",description:"Сколько последних строк вернуть: от 1 до 400, по умолчанию 120"},
      grep:{type:"string",description:"Оставить только строки, содержащие это слово (без учёта регистра)"},
    },
  },
  execute: async (input,context) => {
    await getSandbox(context.projectId,context.userId);
    const value=(input??{}) as {lines?:unknown;grep?:unknown};
    const requested=typeof value.lines==="number"&&Number.isFinite(value.lines)?value.lines:120;
    const grep=typeof value.grep==="string"?value.grep.trim().slice(0,200):"";
    const current=await previewLogs(context.projectId);
    const tail=tailLogLines(current.logs,requested,grep);
    let logs=tail.lines.join("\n");
    const truncated=logs.length>PREVIEW_LOG_MAX_CHARS;
    if(truncated)logs=logs.slice(-PREVIEW_LOG_MAX_CHARS);
    return {
      ok:current.running,
      running:current.running,
      lines:tail.lines.length,
      totalLines:tail.total,
      matchedLines:tail.matched,
      truncated,
      ...(grep?{grep}:{}),
      logs,
      note:!current.running
        ? "Предпросмотр не запущен: логов нет. Запустите его через preview.start."
        : !tail.lines.length
          ? grep
            ? "В логе нет строк с «"+grep+"». Попробуйте более короткое слово или вызовите без grep."
            : "Пока нет вывода: приложение ещё ничего не написало."
          : "Это хвост вывода текущего предпросмотра этого проекта: сборка/запуск и серверная часть; в режиме dev-сервера — его вывод.",
    };
  },
});
