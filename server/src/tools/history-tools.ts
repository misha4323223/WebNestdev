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

export type HistoryTurn = { index: number; role: "user" | "assistant"; text: string };

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

registerTool({
  name: "chat.history",
  description:
    "Read the stored conversation of this chat verbatim — the part that is no longer in your context. Input: {query?: string, limit?: number}. Without a query it returns the newest turns (default 12, max 30); with a query it searches the WHOLE stored chat for a word or phrase and returns the newest matches. Only the user's messages and your own answers come back, clipped head+tail per turn, never tool logs. Use it when a concrete detail from earlier is missing from the visible history and from the notes: what was asked at the start, which variant was agreed, a name, a number, a domain. Do not use it to re-read what is already visible, and prefer note.remember for decisions so they do not have to be searched for again.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Слово или фраза для поиска по всей сохранённой переписке; без него — последние реплики" },
      limit: { type: "integer", description: "Сколько реплик вернуть: по умолчанию 12, максимум 30" },
    },
  },
  execute: async (input, context) => {
    const value = (input && typeof input === "object" ? input : {}) as { query?: unknown; limit?: unknown };
    const query = typeof value.query === "string" ? value.query : "";
    const requested = typeof value.limit === "number" && Number.isFinite(value.limit) ? Math.round(value.limit) : DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
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
      note: kept.length
        ? "Это дословные реплики из сохранённой переписки, а не пересказ. Свежие шаги и решения видны и без этого вызова."
        : query
          ? "В сохранённой переписке нет реплик с этим словом. Проверь формулировку, посмотри заметки решений или файлы проекта."
          : "В этом разговоре ещё нет реплик.",
    };
  },
});
