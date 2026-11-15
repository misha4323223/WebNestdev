import type { ChatMessage } from "./types";
import { parseUiBlocks, type UiBlock } from "./ui-blocks";

function parseToolResult(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function resultFailed(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

/**
 * UI-блоки из сохранённой истории. Источник — аргументы вызова `ui.render`, а не
 * результат инструмента: так интерфейс не дублируется в контексте модели и переживает
 * перезагрузку. Результат нужен только чтобы не рисовать отвергнутый схемой вызов.
 *
 * Блок принадлежит следующему текстовому ответу агента — тому же месту, где человек
 * ждёт итог. Если ответа ещё нет (запуск прерван), он остаётся на ходе с вызовом.
 */
export function chatUiByMessage(messages: ChatMessage[]): Map<ChatMessage, UiBlock[]> {
  const results = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    results.set(message.tool_call_id, parseToolResult(message.content));
  }

  const answerAfter = (index: number) => {
    for (let next = index + 1; next < messages.length; next++) {
      const candidate = messages[next];
      if (candidate.role === "user") break;
      if (candidate.role === "assistant" && candidate.content.trim() && !candidate.tool_calls?.length) return next;
    }
    return index;
  };

  const ui = new Map<ChatMessage, UiBlock[]>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (call.name !== "ui.render") continue;
      const result = results.get(call.id);
      if (!result || resultFailed(result)) continue;
      const blocks = parseUiBlocks(call.arguments);
      if (!blocks?.length) continue;
      const owner = messages[answerAfter(index)];
      if (!owner) continue;
      ui.set(owner, [...(ui.get(owner) ?? []), ...blocks]);
    }
  }
  return ui;
}
