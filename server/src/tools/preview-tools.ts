import { getSandbox } from "../sandbox-manager.js";
import { startPreview,stopPreview,previewStatus,previewLogs } from "../preview-manager.js";
import { tailLogLines } from "../preview/log-lines.js";
import { registerTool } from "../tool-registry.js";

/**
 * These three take no arguments at all, and the schema says so. Leaving it open (`additionalProperties`
 * unset) invited models to send guesses like `{port:3000}`, and a rejected call costs a whole step.
 */
const NO_ARGUMENTS = { type: "object", additionalProperties: false, properties: {} };

registerTool({
  name:"preview.start",
  description:"Start the project's live preview server after creating or updating the project.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {return startPreview(await getSandbox(context.projectId,context.userId))}
});
registerTool({
  name:"preview.stop",
  description:"Stop the project's live preview server.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {await getSandbox(context.projectId,context.userId);return stopPreview(context.projectId)}
});
registerTool({
  name:"preview.status",
  description:"Check whether the project's live preview is running.",
  parameters:NO_ARGUMENTS,
  execute: async (_,context) => {await getSandbox(context.projectId,context.userId);return previewStatus(context.projectId)}
});

/** Сколько символов лога возвращается модели: хвост ошибки, а не весь вывод запуска. */
const PREVIEW_LOG_MAX_CHARS = 10_000;

registerTool({
  name:"preview.logs",
  description:
    "Read the tail of the running Preview's dev-server output. Input: {lines?:number (1–400, default 120), grep?:string (case-insensitive filter)}. " +
    "Use it when the Preview fails to start, a route returns a server error, or project.verify points to startup logs: the error and the exact command are in this output, not in the page HTML. " +
    "The Preview must be running; start it with preview.start first. Logs are a snapshot: read them after a check, not instead of it.",
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
          : "Это хвост вывода dev-сервера; ошибки запуска и запросов ищите здесь.",
    };
  },
});
