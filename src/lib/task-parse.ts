/** Одна задача, вынутая из ответа агента. */
export type ParsedTask = {
  title: string;
  section?: string;
  done: boolean;
};

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*(.*)$/;
const FENCE = /^(```|~~~)/;

function plain(value: string) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Список из ответа агента — это ещё не файл: в ответе бывают вступления, таблицы и куски кода.
 * Парсер берёт только пункты списка верхнего уровня вне fenced-блоков, сохраняет ближайший
 * заголовок как раздел и не дублирует одинаковые пункты. Кнопка «В задачи» показывает число
 * найденных пунктов до записи, поэтому человек видит, что именно уйдёт в TASKS.md.
 */
export function parseTaskList(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const seen = new Set<string>();
  let section: string | undefined;
  let inFence = false;

  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    if (FENCE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING.exec(trimmed);
    if (heading) {
      const value = plain(heading[2]).replace(/^#+\s*/, "");
      section = value || undefined;
      continue;
    }

    const item = LIST_ITEM.exec(raw);
    if (!item) continue;
    // Вложенные пункты обычно уточняют родительский, а не являются отдельной задачей.
    if (item[1].replace(/\t/g, "  ").length > 2) continue;

    let text = item[2].trim();
    let done = false;
    const checkbox = CHECKBOX.exec(text);
    if (checkbox) {
      done = checkbox[1].toLowerCase() === "x";
      text = checkbox[2];
    }
    const title = plain(text).slice(0, 500);
    if (!title) continue;

    const key = (section ?? "") + "|" + title.toLocaleLowerCase("ru");
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ title, done, ...(section ? { section } : {}) });
    if (tasks.length >= 100) break;
  }

  return tasks;
}
