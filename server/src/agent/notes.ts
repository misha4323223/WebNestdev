import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";

/**
 * Записка о согласованном — то, чего не хватало контексту.
 *
 * Срез истории (`cutNote`) восстанавливается из переписки и всегда теряет часть конкретики: он
 * ограничен по размеру, речь в нём сжата, а договорённость часто живёт в одной фразе («тёмная
 * палитра, шрифт Inter, второй вариант отвергнут»). Поэтому решения записываются отдельно — и не
 * пересказом, а дословно, как их назвал агент. Файл лежит в проекте, в служебной папке
 * `.webnestdev/` (она исключена из истории git), поэтому решения переживают сокращение контекста,
 * новый запуск и возврат к разговору на следующий день.
 *
 * Список ограничен по числу строк и размеру: старейшее вытесняется первым. Шестьдесят строк — это
 * заметно больше дневной работы, и на диске такая заметка ничего не стоит.
 */

export const NOTES_PREFIX = "ПРИНЯТЫЕ РЕШЕНИЯ И СОГЛАСОВАННЫЕ ФАКТЫ";
export const NOTES_DIR = ".webnestdev";
/** Сколько записей хранится: дальше вытесняются самые старые. */
export const NOTES_MAX_LINES = 60;
/** Предел самого файла — страховка от гигантских записей, а не рабочий лимит. */
export const NOTES_MAX_CHARS = 6000;
/** Одна запись короче этой не несёт факта («ок»), длиннее — уже пересказ, а не решение. */
export const NOTE_MIN_CHARS = 3;
export const NOTE_MAX_CHARS = 400;

export type NoteKind = "decision" | "rejected" | "open" | "fact";

const KIND_LABEL: Record<NoteKind, string> = {
  decision: "решено",
  rejected: "отклонено",
  open: "открыто",
  fact: "факт",
};

export function isNoteKind(value: unknown): value is NoteKind {
  return value === "decision" || value === "rejected" || value === "open" || value === "fact";
}

/** Одна строка заметки: тип решения виден до текста, поэтому срез читается без пояснений. */
export function formatNoteLine(kind: NoteKind, text: string) {
  return "- [" + KIND_LABEL[kind] + "] " + text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX_CHARS);
}

/**
 * Заметки принадлежат разговору, а не проекту: в разных чатах одного проекта договариваются о
 * разном. Без идентификатора разговора остаётся общая заметка проекта.
 */
export function notesFile(conversationId?: string) {
  const safe = (conversationId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return NOTES_DIR + "/" + (safe ? "notes-" + safe : "notes") + ".md";
}

function parseLines(raw: string): string[] {
  return raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- ["));
}

/** Последние строки — то, что ещё живо; старые вытесняются по числу и по размеру файла. */
export function trimNoteLines(lines: string[]): string[] {
  let kept = lines.slice(Math.max(0, lines.length - NOTES_MAX_LINES));
  while (kept.length > 1 && kept.join("\n").length > NOTES_MAX_CHARS) kept = kept.slice(1);
  return kept;
}

export async function readNoteLines(projectId: string, userId: string, conversationId?: string): Promise<string[]> {
  const sandbox = await getSandbox(projectId, userId);
  const file = path.join(sandbox.root, notesFile(conversationId));
  try {
    return trimNoteLines(parseLines(await readFile(file, "utf8")));
  } catch {
    return [];
  }
}

export async function appendNoteLine(
  projectId: string,
  userId: string,
  conversationId: string | undefined,
  line: string,
): Promise<{ lines: string[]; added: boolean; file: string }> {
  const sandbox = await getSandbox(projectId, userId);
  const relative = notesFile(conversationId);
  const file = path.join(sandbox.root, relative);
  const current = await readNoteLines(projectId, userId, conversationId);
  // Одинаковую договорённость не дублируем: заметка читается моделью каждый шаг, и повторы
  // вытеснили бы из неё другие решения.
  if (current.includes(line)) return { lines: current, added: false, file: relative };
  const lines = trimNoteLines([...current, line]);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  return { lines, added: true, file: relative };
}

/**
 * Что модель читает перед первым шагом. Заметка стоит отдельным системным сообщением, которое
 * обрезка контекста не трогает: системные сообщения не выбрасываются и не сокращаются.
 */
export function notesNotice(lines: string[]) {
  if (!lines.length) {
    return NOTES_PREFIX + ": пока пусто. Когда вы с пользователем договорились о конкретике — палитра и шрифты, имена и заголовки, структура страницы, выбранный вариант, отвергнутая идея — сразу запиши это через note.remember. Записи переживают сокращение контекста и следующий запуск, а пересказ истории их теряет.";
  }
  return [
    NOTES_PREFIX + " (это уже согласовано; не переспрашивай и не переделывай без просьбы):",
    ...lines,
    "Новое решение записывай через note.remember — короткой строкой, без пересказа.",
  ].join("\n");
}
