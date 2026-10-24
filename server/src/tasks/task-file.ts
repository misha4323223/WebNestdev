import { createHash } from "node:crypto";
import path from "node:path";
import { readFileInside, writeFileInside } from "../sandbox/path-guard.js";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";

/**
 * Задачи проекта — обычный `TASKS.md` в корне, а не отдельная база.
 *
 * Причина в общей точке: файл читает и человек во вкладке «Файлы», и агент через файловые
 * инструменты, и новая вкладка «Задачи». Поэтому задача, поставленная из ответа агента, не
 * теряется при смене чата и остаётся видимой в следующем запуске. Формат — markdown-чекбоксы:
 * `- [ ]` и `- [x]`; заголовки `##` задают разделы. Остальные строки файла сохраняются как есть.
 */

export const TASKS_FILE = "TASKS.md";
/** Потолок файла: больше — это уже не список задач, а документ, который не надо тянуть в панель. */
const MAX_FILE_CHARS = 200_000;
const MAX_TITLE_CHARS = 500;
const MAX_SECTION_CHARS = 120;
const MAX_TASKS = 1000;

const TASK_LINE = /^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/;
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_LINE = /^(```|~~~)/;

export type TaskItem = {
  /** Номер строки в файле, с единицы: по нему вкладка меняет именно этот пункт. */
  line: number;
  title: string;
  done: boolean;
  section: string | null;
  /** Вложенность для отображения; файл при этом остаётся обычным markdown. */
  depth: number;
};

export type TasksState = {
  file: string;
  exists: boolean;
  /** Хеш содержимого: устаревшая панель не перезапишет правку агента или другого окна. */
  revision: string;
  markdown: string;
  tasks: TaskItem[];
  total: number;
  done: number;
};

export type TaskInput = {
  title: string;
  section?: string;
  done?: boolean;
};

/**
 * Конфликт версий — не ошибка сервера, а нормальная ситуация: файл мог изменить агент или
 * человек во вкладке «Файлы». Маршрут отвечает 409 и отдаёт свежий список, чтобы панель
 * показала его, а не затёрла чужую работу.
 */
export class TasksConflictError extends Error {
  constructor(message: string, readonly state: TasksState) {
    super(message);
    this.name = "TasksConflictError";
  }
}

function cleanText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(value: string) {
  return cleanText(value).slice(0, MAX_TITLE_CHARS);
}

function normalizeSection(value: string | undefined) {
  return cleanText(value ?? "").replace(/^#+\s*/, "").slice(0, MAX_SECTION_CHARS);
}

function revisionOf(markdown: string) {
  return createHash("sha256").update(markdown, "utf8").digest("hex").slice(0, 16);
}

function parseTasks(markdown: string): TaskItem[] {
  const lines = markdown.split("\n");
  const tasks: TaskItem[] = [];
  let section: string | null = null;
  let inFence = false;

  for (let index = 0; index < lines.length && tasks.length < MAX_TASKS; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (FENCE_LINE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING_LINE.exec(trimmed);
    if (heading) {
      // `# Задачи проекта` — заголовок документа, а не раздел. Разделы начинаются с `##`.
      section = heading[1].length === 1 ? null : normalizeSection(heading[2]) || null;
      continue;
    }

    const task = TASK_LINE.exec(raw);
    if (!task) continue;
    const title = normalizeTitle(task[4]);
    if (!title) continue;
    const indent = task[1].replace(/\t/g, "  ").length;
    tasks.push({
      line: index + 1,
      title,
      done: task[3].toLowerCase() === "x",
      section,
      depth: Math.min(2, Math.floor(indent / 2)),
    });
  }

  return tasks;
}

function stateOf(markdown: string, exists: boolean): TasksState {
  const tasks = parseTasks(markdown);
  return {
    file: TASKS_FILE,
    exists,
    revision: revisionOf(markdown),
    markdown,
    tasks,
    total: tasks.length,
    done: tasks.filter(task => task.done).length,
  };
}

export async function readTasks(root: string): Promise<TasksState> {
  let markdown = "";
  let exists = false;
  try {
    markdown = await readFileInside(root, path.join(root, TASKS_FILE));
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (markdown.length > MAX_FILE_CHARS) {
    throw new Error("TASKS.md слишком большой: список задач должен оставаться компактным.");
  }
  return stateOf(markdown, exists);
}

function assertRevision(state: TasksState, revision: string | undefined) {
  if (revision !== undefined && revision !== state.revision) {
    throw new TasksConflictError("Список задач изменился в другом месте — обновите его и повторите.", state);
  }
}

async function writeTasks(root: string, markdown: string): Promise<TasksState> {
  const written = await writeFileInside(root, path.join(root, TASKS_FILE), markdown);
  // Контейнер работает от uid 1000, а сервер пишет от root: без этого файл стал бы доступен
  // только на чтение и агент не смог бы его поправить.
  await openDirsForSandbox(root, path.dirname(written));
  await openFileForSandbox(written);
  return stateOf(markdown, true);
}

/** Вставляет строки в документ, сохраняя пустую строку до и после блока. */
function insertBlock(
  lines: string[],
  at: number,
  block: string[],
  options: { before?: boolean; after?: boolean } = {},
) {
  if (!block.length) return;
  const before = options.before ?? (at > 0 && lines[at - 1] !== "");
  const after = options.after ?? (at < lines.length && lines[at] !== "");
  lines.splice(at, 0, ...(before ? [""] : []), ...block, ...(after ? [""] : []));
}

function sectionIndex(lines: string[], section: string) {
  const wanted = section.toLocaleLowerCase("ru");
  for (let index = 0; index < lines.length; index++) {
    const heading = HEADING_LINE.exec(lines[index].trim());
    if (!heading || heading[1].length < 2) continue;
    if (normalizeSection(heading[2]).toLocaleLowerCase("ru") === wanted) return index;
  }
  return -1;
}

function sectionEnd(lines: string[], start: number) {
  for (let index = start + 1; index < lines.length; index++) {
    const heading = HEADING_LINE.exec(lines[index].trim());
    if (heading && heading[1].length <= 2) return index;
  }
  return lines.length;
}

function addToMarkdown(markdown: string, section: string | undefined, block: string[]) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) lines.push("# Задачи проекта", "");

  if (section) {
    const start = sectionIndex(lines, section);
    if (start >= 0) {
      let at = sectionEnd(lines, start);
      // Пустые строки перед следующим разделом не должны уехать вниз: задачи встают сразу
      // за последним пунктом раздела, а не через три пустые строки.
      while (at > start + 1 && lines[at - 1] === "") at--;
      // Пункты одного раздела стоят подряд, без пустой строки между каждым.
      insertBlock(lines, at, block, { before: at > 0 && TASK_LINE.test(lines[at - 1]) ? false : undefined });
    } else {
      insertBlock(lines, lines.length, ["## " + section, "", ...block], {
        before: lines.length > 0 && lines[lines.length - 1] !== "",
      });
    }
  } else {
    // Пункты без раздела живут между заголовком документа и первым `##`.
    const firstSection = lines.findIndex(line => /^##\s+/.test(line.trim()));
    let at = firstSection < 0 ? lines.length : firstSection;
    // Вставка идёт сразу за последним пунктом вступления, иначе пустая строка перед
    // разделом добавляла вторую и документ «дышал» при каждом нажатии.
    while (at > 0 && lines[at - 1] === "") at--;
    insertBlock(lines, at, block, {
      before: at > 0 && TASK_LINE.test(lines[at - 1]) ? false : undefined,
      after: at < lines.length && lines[at] !== "" ? undefined : false,
    });
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Один проект — одна очередь записи. Два окна или кнопка в чате и панель могут нажать почти
 * одновременно; revision ловит конфликт, но без очереди оба запроса успели бы прочитать старый
 * файл и второй молча затёр первый. Очередь живёт в памяти процесса; при нескольких репликах
 * последним рубежом остаётся revision.
 */
const locks = new Map<string, Promise<void>>();
async function withTasksLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate, () => gate);
  locks.set(key, tail);
  try {
    await previous.catch(() => undefined);
    return await run();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export async function addTasks(
  root: string,
  input: { items: TaskInput[]; section?: string; revision?: string },
): Promise<TasksState & { added: number; skipped: number }> {
  return withTasksLock("tasks:" + root, async () => {
    const state = await readTasks(root);
    assertRevision(state, input.revision);

    const known = new Set(state.tasks.map(task => normalizeTitle(task.title).toLocaleLowerCase("ru")));
    const groups = new Map<string | undefined, string[]>();
    let skipped = 0;

    for (const item of input.items) {
      const title = normalizeTitle(item.title);
      if (!title) { skipped++; continue; }
      const key = title.toLocaleLowerCase("ru");
      if (known.has(key)) { skipped++; continue; }
      known.add(key);

      const section = normalizeSection(item.section || input.section) || undefined;
      const group = groups.get(section) ?? [];
      group.push((item.done ? "- [x] " : "- [ ] ") + title);
      groups.set(section, group);
    }

    const added = [...groups.values()].reduce((sum, group) => sum + group.length, 0);
    if (!added) return { ...state, added: 0, skipped };

    let markdown = state.markdown;
    for (const [section, block] of groups) markdown = addToMarkdown(markdown, section, block);
    const next = await writeTasks(root, markdown);
    return { ...next, added, skipped };
  });
}

export async function toggleTask(
  root: string,
  input: { line: number; done: boolean; revision: string },
): Promise<TasksState> {
  return withTasksLock("tasks:" + root, async () => {
    const state = await readTasks(root);
    assertRevision(state, input.revision);

    const lines = state.markdown.replace(/\r\n/g, "\n").split("\n");
    const index = input.line - 1;
    const task = TASK_LINE.exec(lines[index] ?? "");
    if (!task) {
      throw new TasksConflictError("Задача не найдена — список изменился. Обновите его.", state);
    }
    lines[index] = task[1] + task[2] + " [" + (input.done ? "x" : " ") + "] " + task[4];
    return writeTasks(root, lines.join("\n"));
  });
}

/**
 * После удаления последней задачи раздел остаётся пустым заголовком, а на его месте — две
 * пустые строки. Такой файл читается как черновик, а не как список дел, поэтому заголовок
 * удаляется, если до следующего заголовка того же уровня в нём нет ни задач, ни текста.
 * Пустые строки схлопываются до одной; рукописные вступления сохраняются.
 */
function tidyAfterRemove(lines: string[]) {
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = HEADING_LINE.exec(lines[index].trim());
    if (heading && heading[1].length >= 2) {
      let next = index + 1;
      while (next < lines.length && lines[next].trim() === "") next++;
      const nextHeading = next < lines.length ? HEADING_LINE.exec(lines[next].trim()) : null;
      const isLast = next >= lines.length;
      const sameOrHigher = nextHeading ? nextHeading[1].length <= heading[1].length : false;
      if (isLast || sameOrHigher) {
        index = next - 1;
        continue;
      }
    }
    if (lines[index].trim() === "" && kept.length && kept[kept.length - 1].trim() === "") continue;
    kept.push(lines[index]);
  }
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  return kept;
}

export async function removeTask(
  root: string,
  input: { line: number; revision: string },
): Promise<TasksState> {
  return withTasksLock("tasks:" + root, async () => {
    const state = await readTasks(root);
    assertRevision(state, input.revision);

    const lines = state.markdown.replace(/\r\n/g, "\n").split("\n");
    const index = input.line - 1;
    if (!TASK_LINE.test(lines[index] ?? "")) {
      throw new TasksConflictError("Задача не найдена — список изменился. Обновите его.", state);
    }
    lines.splice(index, 1);
    return writeTasks(root, tidyAfterRemove(lines).join("\n") + "\n");
  });
}
