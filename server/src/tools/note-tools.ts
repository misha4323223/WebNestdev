import { appendNoteLine, findNoteLines, formatNoteLine, isNoteKind, normalizeNoteTags, NOTE_MAX_CHARS, NOTE_MIN_CHARS, readNoteLines } from "../agent/notes.js";
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
    "Record a decision or agreed fact so it survives context trimming. Use it the moment you and the user settle something concrete: palette, fonts, names and headings, page structure, the chosen layout variant, a rejected idea, a price, a phone number, an event date. Input: {text: short fact in the user's language, kind?: 'decision'|'rejected'|'open'|'fact', tags?: string[]} (default 'decision'; up to five short tags like 'ui', 'auth', 'deploy'). The notes are stored in the project (`.webnestdev/notes-<conversation>.md`, outside git) and are given to you at the start of every run and after every cut, so never re-decide or re-ask what is already there. Returns the full list. Do not use it as a log of steps — plan.update is for steps, this is for what you decided.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", description: "Короткий факт: «палитра #0E1A16, шрифт Inter», «галерея 3 колонки на десктопе», «вариант с тёмным героем отклонён»" },
      kind: { type: "string", enum: ["decision", "rejected", "open", "fact"], description: "Что это: решение, отклонённый вариант, открытый вопрос или факт о проекте" },
      tags: { type: "array", maxItems: 5, description: "Короткие метки для поиска, без #: ui, auth, deploy", items: { type: "string", maxLength: 24 } },
    },
  },
  execute: async (input, context) => {
    const value = (input && typeof input === "object" ? input : {}) as { text?: unknown; kind?: unknown; tags?: unknown };
    const raw = typeof value.text === "string" ? value.text.replace(/\s+/g, " ").trim() : "";
    const text = raw.slice(0, NOTE_MAX_CHARS);
    if (text.length < NOTE_MIN_CHARS) {
      return { ok: false, error: "Нужен короткий факт: например «палитра #0E1A16, шрифт Inter»." };
    }
    const kind = isNoteKind(value.kind) ? value.kind : "decision";
    const tags = normalizeNoteTags(value.tags);
    const line = formatNoteLine(kind, text, tags);
    try {
      const result = await appendNoteLine(context.projectId, context.userId, context.conversationId, line);
      return {
        ok: true,
        added: result.added,
        note: line,
        ...(tags.length ? { tags } : {}),
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

registerTool({
  name: "note.find",
  description:
    "Search the stored notes of this chat instead of reading all of them: by text, by tag, or both. Input: {query?:string, tag?:string, limit?:number (1–60, default 10)}. " +
    "Returns the newest matching note lines with their kind and tags. Use it when a decision is not in the visible note block or the list has grown long; use note.remember to record a new one.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", description: "Слово или фраза в тексте заметки" },
      tag: { type: "string", description: "Метка без #: ui, auth, deploy" },
      limit: { type: "integer", minimum: 1, maximum: 60, description: "Сколько последних совпадений вернуть; по умолчанию 10" },
    },
  },
  execute: async (input, context) => {
    const value = (input && typeof input === "object" ? input : {}) as { query?: unknown; tag?: unknown; limit?: unknown };
    const query = typeof value.query === "string" ? value.query.trim() : "";
    const tag = normalizeNoteTags(value.tag)[0] ?? "";
    const limit = typeof value.limit === "number" && Number.isFinite(value.limit) ? Math.round(value.limit) : 10;
    if (!query && !tag) return { ok: false, error: "Укажите query или tag — иначе проще прочитать заметки целиком." };
    try {
      const lines = await readNoteLines(context.projectId, context.userId, context.conversationId);
      const found = findNoteLines(lines, query, tag, limit);
      return {
        ok: true,
        ...(query ? { query } : {}),
        ...(tag ? { tag } : {}),
        total: lines.length,
        matched: found.matched,
        returned: found.lines.length,
        truncated: found.matched > found.lines.length,
        notes: found.lines,
        note: found.lines.length
          ? "Это строки из сохранённых заметок с типом и метками. Если решения нет — запишите его через note.remember."
          : "Совпадений нет. Проверьте формулировку или метку; список заметок виден в начале запуска.",
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
