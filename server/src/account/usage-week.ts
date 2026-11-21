/**
 * Календарная неделя квоты — UTC, с понедельника 00:00.
 *
 * Отдельный модуль, а не ещё одна функция в usage-store: границу недели используют и счётчик,
 * и ответ API, и тесты. Держать её в одном месте дешевле, чем повторять арифметику с воскресеньем.
 */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Понедельник текущей UTC-недели в формате YYYY-MM-DD. */
export function utcWeekStart(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay(): воскресенье = 0. Для понедельника как первого дня сдвигаем на 6.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** Дни от понедельника до сегодняшнего дня включительно; нужны для подсчёта по дневным файлам. */
export function weekDays(now = new Date()): string[] {
  const start = new Date(utcWeekStart(now) + "T00:00:00.000Z");
  const today = new Date(utcDay(now) + "T00:00:00.000Z");
  const days: string[] = [];
  for (let cursor = start; cursor <= today; cursor = new Date(cursor.getTime() + 86_400_000)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}
