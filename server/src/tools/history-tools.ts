import { getConversation } from "../project-store.js";
import { registerTool } from "../tool-registry.js";
import { clip } from "../agent/context-budget.js";
import type { ChatMessage } from "../types.js";

/**
 * Чтение сохранённой переписки — вместо второй «сжатой копии».
 *
 * Разговор целиком уже лежит на сервере: сообщения, вызовы инструментов, их результаты,
 * размышления. В контекст он не помещается, поэтому старые шаги сворачиваются в срез, а решения —
 * в заметки (`note.remember`). Но иногда нужен именно старый фрагмент: «какой цвет мы согласовали
 * в начале», «что я просил до правок», «какой домен упоминали». Пересказ тут не годится, а вторая
 * копия переписки неизбежно расходится с настоящей. Поэтому инструмент читает настоящую —
 * дословно, по запросу и в ограниченном объёме.
 */

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 30;
/** Одна реплика отдаётся краями: начало задаёт тему, конец обычно содержит вывод. */
const TURN_HEAD_CHARS = 450;
const TURN_TAIL_CHARS = 250;
/** Сколько символов реплик отдаётся за один вызов — модель читает результат целиком. */
const MAX_RESULT_CHARS = 9000;
/** Результаты инструментов — отдельная, более скромная квота: их просят точечно. */
const MAX_TOOL_RESULT_CHARS = 3000;
const TOOL_RESULT_HEAD_CHARS = 700;
const TOOL_RESULT_TAIL_CHARS = 300;
const TOOL_ARGUMENT_HEAD_CHARS = 300;
const TOOL_ARGUMENT_TAIL_CHARS = 100;
const MAX_TOOL_TURNS = 8;

export type HistoryTurn = { index: number; role: "user" | "assistant"; text: string };
export type HistoryToolTurn = { index: number; name: string; arguments: string; result: string };

/**
 * Реплики разговора без шагов инструментов: они нужны, чтобы прочитать договорённость, а не журнал
 * сборки. При поиске по слову просматривается вся сохранённая переписка, а возвращаются самые
 * свежие совпадения — старые важны, но их место в заметках.
 */
export function selectTurns(messages: ChatMessage[], query: string, limit: number): { turns: HistoryTurn[]; matched: number } {
  const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  const found: HistoryTurn[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return;
    const text = message.content.replace(/\s+/g, " ").trim();
    if (!text) return;
    if (needle && !text.toLowerCase().includes(needle)) return;
    found.push({ index, role: message.role, text });
  });
  return { turns: found.slice(Math.max(0, found.length - limit)), matched: found.length };
}

/** Ужимает список до общего предела, выбрасывая самые старые реплики, а не хвост последней. */
export function fitTurns(turns: HistoryTurn[]): HistoryTurn[] {
  const kept: HistoryTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const text = clip(turns[index].text, TURN_HEAD_CHARS, TURN_TAIL_CHARS, "реплика сокращена");
    if (kept.length && used + text.length > MAX_RESULT_CHARS) break;
    kept.unshift({ ...turns[index], text });
    used += text.length;
  }
  return kept;
}

/**
 * Результаты инструментов из сохранённой переписки. Раньше `chat.history` отдавал только
 * реплики, и после обрезки контекста агент заново запускал grep или сборку, хотя вывод уже был
 * записан. Пары «вызов — результат» собираются по `tool_call_id`: непарный результат модель
 * всё равно не примет, а искать по нему нечего.
 */
export function selectToolResults(messages: ChatMessage[], query: string, limit: number): { tools: HistoryToolTurn[]; matched: number } {
  const calls = new Map<string, { name: string; arguments: string; index: number }>();
  const all: HistoryToolTurn[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        calls.set(call.id, { name: call.name, arguments: JSON.stringify(call.arguments), index });
      }
      return;
    }
    if (message.role !== "tool") return;
    const call = calls.get(message.tool_call_id);
    if (!call) return;
    calls.delete(message.tool_call_id);
    all.push({ index: call.index, name: call.name, arguments: call.arguments, result: message.content });
  });

  const needle = query.replace(/\s+/g, " ").trim().toLowerCase();
  const matched = all.filter(item =>
    !needle || (item.name + " " + item.arguments + " " + item.result).toLowerCase().includes(needle),
  );
  return { tools: matched.slice(Math.max(0, matched.length - Math.max(1, limit))), matched: matched.length };
}

/** Ужимает результаты инструментов: модели нужен нужный кусок, а не весь вывод сборки. */
export function fitToolTurns(turns: HistoryToolTurn[]): HistoryToolTurn[] {
  const kept: HistoryToolTurn[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const argumentsText = clip(turns[index].arguments, TOOL_ARGUMENT_HEAD_CHARS, TOOL_ARGUMENT_TAIL_CHARS, "аргументы сокращены");
    const result = clip(turns[index].result, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS, "результат инструмента сокращён");
    if (kept.length && used + argumentsText.length + result.length > MAX_TOOL_RESULT_CHARS) break;
    kept.unshift({ ...turns[index], arguments: argumentsText, result });
    used += argumentsText.length + result.length;
  }
  return kept;
}

registerTool({
  name: "chat.history",
  description:
    "Read the stored conversation of this chat verbatim — the part that is no longer in your context. Input: {query?: string, limit?: number, tools?: boolean}. Without a query it returns the newest turns (default 12, max 30); with a query it searches the WHOLE stored chat for a word or phrase and returns the newest matches. " +
    "By default only the user's messages and your own answers come back, clipped head+tail per turn. With tools:true it also returns saved tool calls and their results (newest matches, clipped and bounded): use it when a command output, file read or verification result was trimmed from the visible context, instead of running the same command again. " +
    "Use it when a concrete detail from earlier is missing from the visible history and from the notes: what was asked at the start, which variant was agreed, a name, a number, a domain, a build or verify result. Do not use it to re-read what is already visible, and prefer note.remember for decisions so they do not have to be searched for again.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Слово или фраза для поиска по всей сохранённой переписке; без него — последние реплики" },
      limit: { type: "integer", description: "Сколько реплик вернуть: по умолчанию 12, максимум 30" },
      tools: { type: "boolean", description: "Искать ещё и по сохранённым вызовам инструментов и их результатам; по умолчанию false" },
    },
  },
  execute: async (input, context) => {
    const value = (input && typeof input === "object" ? input : {}) as { query?: unknown; limit?: unknown; tools?: unknown };
    const query = typeof value.query === "string" ? value.query : "";
    const requested = typeof value.limit === "number" && Number.isFinite(value.limit) ? Math.round(value.limit) : DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
    const includeTools = value.tools === true;
    if (!context.conversationId) {
      return { ok: false, error: "У этого запуска нет сохранённого разговора: читать нечего. Работай с тем, что видно в контексте, и с файлами проекта." };
    }
    let conversation;
    try {
      conversation = await getConversation(context.conversationId);
    } catch (error) {
      return { ok: false, error: "Не удалось прочитать разговор: " + (error instanceof Error ? error.message : String(error)) };
    }
    // Разговор принадлежит проекту: чужой чат этим путём не читается.
    if (!conversation || conversation.projectId !== context.projectId) {
      return { ok: false, error: "Разговор не найден в этом проекте." };
    }
    const { turns, matched } = selectTurns(conversation.messages, query, limit);
    const kept = fitTurns(turns);
    const toolSelection = includeTools
      ? selectToolResults(conversation.messages, query, Math.min(MAX_TOOL_TURNS, limit))
      : null;
    const keptTools = toolSelection ? fitToolTurns(toolSelection.tools) : [];
    return {
      ok: true,
      title: conversation.title,
      query: query.trim() || null,
      messagesTotal: conversation.messages.length,
      matched,
      returned: kept.length,
      /** Старые совпадения не влезли — об этом честно, а не молча. */
      truncated: matched > kept.length,
      turns: kept,
      ...(toolSelection ? {
        tools: keptTools,
        toolsMatched: toolSelection.matched,
        toolsReturned: keptTools.length,
        toolsTruncated: toolSelection.matched > keptTools.length,
      } : {}),
      note: kept.length && keptTools.length
        ? "Это дословные реплики и сохранённые результаты инструментов, а не пересказ. Свежие шаги видны и без этого вызова."
        : kept.length
          ? "Это дословные реплики из сохранённой переписки, а не пересказ. Свежие шаги и решения видны и без этого вызова."
          : keptTools.length
            ? "В репликах совпадений нет, но сохранённые результаты инструментов найдены — они ниже."
            : query
              ? includeTools
                ? "Ни в репликах, ни в результатах инструментов нет совпадений. Проверь формулировку, посмотри заметки решений или файлы проекта."
                : "В сохранённой переписке нет реплик с этим словом. Проверь формулировку, посмотри заметки решений или файлы проекта."
              : "В этом разговоре ещё нет реплик.",
    };
  },
});
