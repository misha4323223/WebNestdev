/**
 * Значение переменной окружения в том виде, в каком его понимает dotenv/Vite/Next: голый токен
 * остаётся как есть, а всё, что содержит пробелы, `#`, `$`, кавычки или переводы строк, берётся
 * в двойные кавычки. Многострочный ключ (PEM) превращается в `\n` внутри строки — иначе перевод
 * строки разорвал бы файл и следующая половина ключа стала бы отдельной переменной.
 */
const BARE_VALUE = /^[A-Za-z0-9_\-./:@+=,]+$/;

export function encodeEnvValue(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (BARE_VALUE.test(normalized)) return normalized;
  return '"' + normalized
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n") + '"';
}
