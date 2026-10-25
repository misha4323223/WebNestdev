/**
 * Двоичный ли это файл. `fs.read` отдаёт текст, но агент может открыть PNG, шрифт или архив:
 * `readFile("utf8")` превращает их в десятки килобайт символов замены, которые занимают контекст
 * и ничего не объясняют. Нулевой байт — надёжный признак; доля символов замены ловит файлы без
 * нулей, например сжатые изображения.
 *
 * Один повреждённый байт в тексте — не повод объявлять файл двоичным: порог начинается с двух
 * замен и одного процента выборки.
 */
const SAMPLE_BYTES = 8192;
const MIN_REPLACEMENTS = 2;
const MAX_REPLACEMENT_RATIO = 0.01;

export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  if (!sample.length) return false;
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  const text = Buffer.from(sample).toString("utf8");
  let replacements = 0;
  for (const character of text) {
    if (character === "\uFFFD") replacements++;
  }
  return replacements >= MIN_REPLACEMENTS && replacements / Math.max(1, text.length) > MAX_REPLACEMENT_RATIO;
}
