/**
 * Небольшие помощники редактора без отдельной библиотеки: отступы, парные скобки и Tab.
 * Они работают на уровне строки и выделения, поэтому не зависят от языка файла и не мешают
 * вставлять готовый код. Полноценного линтера здесь нет — это именно помощь при наборе.
 */
export type EditorEdit = { value: string; start: number; end: number };

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'", "`": "`" };
const CLOSERS = new Set([")", "]", "}", '"', "'", "`"]);

function lineStartAt(value: string, offset: number) {
  return value.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
}

function indentAt(value: string, offset: number) {
  const lineStart = lineStartAt(value, offset);
  return value.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? "";
}

function isWordCharacter(value: string | undefined) {
  return Boolean(value && /[A-Za-zА-Яа-я0-9_$]/.test(value));
}

function pairFor(value: string, start: number, end: number, key: string): EditorEdit | null {
  const close = PAIRS[key];
  if (!close || start !== end) return null;
  // Кавычка после слова — это закрывающая кавычка, а не начало новой строки.
  if ((key === '"' || key === "'" || key === "`") && (isWordCharacter(value[start - 1]) || value[start] === close)) return null;
  return {
    value: value.slice(0, start) + key + close + value.slice(start),
    start: start + 1,
    end: start + 1,
  };
}

function indentSelection(value: string, start: number, end: number): EditorEdit {
  const from = lineStartAt(value, start);
  const to = end;
  const block = value.slice(from, to);
  const next = block
    .split("\n")
    .map(line => line ? "  " + line : line)
    .join("\n");
  return { value: value.slice(0, from) + next + value.slice(to), start: start + 2, end: end + (next.length - block.length) };
}

function outdentSelection(value: string, start: number, end: number): EditorEdit {
  const from = lineStartAt(value, start);
  const block = value.slice(from, end);
  let removedBefore = 0;
  const next = block.split("\n").map((line, index) => {
    const match = line.match(/^ {1,2}/);
    if (!match) return line;
    if (index === 0) removedBefore = match[0].length;
    return line.slice(match[0].length);
  }).join("\n");
  return {
    value: value.slice(0, from) + next + value.slice(end),
    start: Math.max(from, start - removedBefore),
    end: Math.max(from, end - (block.length - next.length)),
  };
}

export function nextEditorValue(
  value: string,
  start: number,
  end: number,
  key: string,
  shiftKey = false,
): EditorEdit | null {
  if (key === "Tab") {
    if (shiftKey) return outdentSelection(value, start, end);
    if (start !== end && value.slice(start, end).includes("\n")) return indentSelection(value, start, end);
    return { value: value.slice(0, start) + "  " + value.slice(end), start: start + 2, end: start + 2 };
  }

  if (key === "Enter") {
    const indent = indentAt(value, start);
    const before = value.slice(0, start).trimEnd().slice(-1);
    const after = value.slice(end).trimStart()[0];
    const extra = "([{".includes(before) ? "  " : "";
    const closing = before === "(" ? ")" : before === "[" ? "]" : before === "{" ? "}" : "";
    if (extra && after === closing) {
      const insert = "\n" + indent + extra + "\n" + indent;
      const cursor = start + 1 + indent.length + extra.length;
      return { value: value.slice(0, start) + insert + value.slice(end), start: cursor, end: cursor };
    }
    const insert = "\n" + indent + extra;
    return { value: value.slice(0, start) + insert + value.slice(end), start: start + insert.length, end: start + insert.length };
  }

  if (key === "Backspace" && start === end) {
    const before = value[start - 1];
    const after = value[start];
    if (before && after && PAIRS[before] === after) {
      return { value: value.slice(0, start - 1) + value.slice(start + 1), start: start - 1, end: start - 1 };
    }
    return null;
  }

  if (key.length === 1) {
    // Закрывающую скобку не дублируем, если она уже стоит сразу после курсора.
    if (CLOSERS.has(key) && value[start] === key && start === end) {
      return { value: value.slice(0, start) + key + value.slice(start + 1), start: start + 1, end: start + 1 };
    }
    return pairFor(value, start, end, key);
  }
  return null;
}

/** Формат JSON: единственная «автоправка», которую можно сделать без языка и зависимостей. */
export function formatJsonText(value: string) {
  return JSON.stringify(JSON.parse(value), null, 2) + "\n";
}
