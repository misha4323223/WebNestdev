/**
 * Построчный diff для Git-панели.
 *
 * Своя реализация, а не зависимость: панель показывает diff одного файла по запросу, и ради
 * этого не нужно тянуть в сервер ещё один пакет. Алгоритм — обычная LCS-таблица, но с жёстким
 * потолком на размер: у файла в десятки тысяч строк таблица съела бы память маленькой ВМ.
 * В этом случае панель честно говорит «файл слишком большой», а не роняет запрос.
 */

export type DiffLineType = " " | "+" | "-";
export type DiffLine = { type: DiffLineType; text: string };

/** Потолок на сравнение: 12 000 строк и 1,5 млн ячеек — уже больше любого исходника. */
const MAX_LINES = 12_000;
const MAX_CELLS = 1_500_000;

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  // Завершающий перевод строки — не отдельная пустая строка; иначе каждый файл получал бы
  // лишний «добавленный» хвост в diff.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Строки, которых нет в другой версии, в порядке файла. `null` — слишком большой файл. */
export function diffLines(before: string[], after: string[]): DiffLine[] | null {
  const n = before.length;
  const m = after.length;
  if (n > MAX_LINES || m > MAX_LINES || n * m > MAX_CELLS) return null;
  if (!n) return after.map(text => ({ type: "+" as const, text }));
  if (!m) return before.map(text => ({ type: "-" as const, text }));

  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = before[i] === after[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ type: " ", text: before[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      lines.push({ type: "-", text: before[i] });
      i++;
    } else {
      lines.push({ type: "+", text: after[j] });
      j++;
    }
  }
  while (i < n) lines.push({ type: "-", text: before[i++] });
  while (j < m) lines.push({ type: "+", text: after[j++] });
  return lines;
}

/**
 * Хунки с контекстом вокруг изменений. Соседние изменения объединяются, если между ними не
 * больше `2 * context` неизменившихся строк — так diff читается блоками, а не по строке.
 */
export function diffHunks(lines: DiffLine[], context = 3): string[] {
  const changed: number[] = [];
  for (let index = 0; index < lines.length; index++) if (lines[index].type !== " ") changed.push(index);
  if (!changed.length) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const output: string[] = [];
  for (const [start, end] of ranges) {
    let oldBefore = 0;
    let newBefore = 0;
    for (let index = 0; index < start; index++) {
      if (lines[index].type !== "+") oldBefore++;
      if (lines[index].type !== "-") newBefore++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let index = start; index < end; index++) {
      if (lines[index].type !== "+") oldCount++;
      if (lines[index].type !== "-") newCount++;
    }
    // Для пустой стороны Git пишет `-0,0`, а не `-1,0`: так diff остаётся привычным для инструментов.
    const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
    const newStart = newCount === 0 ? newBefore : newBefore + 1;
    output.push("@@ -" + oldStart + "," + oldCount + " +" + newStart + "," + newCount + " @@");
    for (let index = start; index < end; index++) output.push(lines[index].type + lines[index].text);
  }
  return output;
}

export type UnifiedPatch = { patch: string; truncated: boolean };

/**
 * Готовый unified diff с заголовком файла. `truncated` — файл слишком большой для построчного
 * сравнения: панель показывает это словами вместо пустого места.
 */
export function unifiedPatch(file: string, beforeText: string, afterText: string, context = 3): UnifiedPatch {
  const lines = diffLines(splitLines(beforeText), splitLines(afterText));
  if (!lines) return { patch: "", truncated: true };
  if (!lines.some(line => line.type !== " ")) return { patch: "", truncated: false };
  return {
    patch: ["--- a/" + file, "+++ b/" + file, ...diffHunks(lines, context)].join("\n") + "\n",
    truncated: false,
  };
}
