import { appendNoteLine, formatNoteLine, isNoteKind, NOTE_MAX_CHARS, NOTE_MIN_CHARS } from "../agent/notes.js";
import { registerTool } from "../tool-registry.js";

/**
 * Единственный способ сказать «это уже решено» так, чтобы это пережило сокращение контекста.
 *
 * История подрезается по бюджету, и в срезе остаются только начало просьбы и края ответов — то есть
 * ровно то место, где договорённости обычно и теряются. Запись через этот инструмент живёт отдельным
 * файлом проекта и приходит модели в начале каждого запуска, поэтому «какой вариант мы выбрали» не
 * приходится выяснять заново.
 */
registerTool({
  name: "note.remember",
  description:
    "Record a decision or agreed fact so it survives context trimming. Use it the moment you and the user settle something concrete: palette, fonts, names and headings, page structure, the chosen layout variant, a rejected idea, a price, a phone number, an event date. Input: {text: short fact in the user's language, kind?: 'decision'|'rejected'|'open'|'fact'} (default 'decision'). The notes are stored in the project (`.webnestdev/notes-<conversation>.md`, outside git) and are given to you at the start of every run and after every cut, so never re-decide or re-ask what is already there. Returns the full list. Do not use it as a log of steps — plan.update is for steps, this is for what you decided.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", description: "Короткий факт: «палитра #0E1A16, шрифт Inter», «галерея 3 колонки на десктопе», «вариант с тёмным героем отклонён»" },
      kind: { type: "string", enum: ["decision", "rejected", "open", "fact"], description: "Что это: решение, отклонённый вариант, открытый вопрос или факт о проекте" },
    },
  },
  execute: async (input, context) => {
    const value = (input && typeof input === "object" ? input : {}) as { text?: unknown; kind?: unknown };
    const raw = typeof value.text === "string" ? value.text.replace(/\s+/g, " ").trim() : "";
    const text = raw.slice(0, NOTE_MAX_CHARS);
    if (text.length < NOTE_MIN_CHARS) {
      return { ok: false, error: "Нужен короткий факт: например «палитра #0E1A16, шрифт Inter»." };
    }
    const kind = isNoteKind(value.kind) ? value.kind : "decision";
    const line = formatNoteLine(kind, text);
    try {
      const result = await appendNoteLine(context.projectId, context.userId, context.conversationId, line);
      return {
        ok: true,
        added: result.added,
        note: line,
        file: result.file,
        total: result.lines.length,
        /** Список целиком: модель видит всю договорённость, а не только что записанную строку. */
        notes: result.lines,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
