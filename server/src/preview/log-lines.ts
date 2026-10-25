/**
 * Хвост логов предпросмотра. Логи приходят одной строкой от `docker logs`, а модели нужен
 * последний осмысленный кусок: первый экран запуска уже неактуален, а фильтр по слову экономит
 * шаг, который иначе уходит на повторный запуск проверки.
 *
 * Функция чистая: её можно проверить без Docker и без запущенного предпросмотра.
 */
export function tailLogLines(raw: string, requested: number, grep?: string) {
  const all = raw.replace(/\r\n/g, "\n").split("\n");
  // Логи почти всегда заканчиваются переводом строки; пустой хвост — не строка вывода.
  if (all.length && all[all.length - 1] === "") all.pop();

  const needle = (grep ?? "").trim().toLowerCase();
  const filtered = needle ? all.filter(line => line.toLowerCase().includes(needle)) : all;
  const take = Math.max(1, Math.min(400, Math.floor(Number(requested)) || 120));
  const lines = filtered.slice(Math.max(0, filtered.length - take));

  return { lines, total: all.length, matched: filtered.length };
}
