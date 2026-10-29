/**
 * Ошибки архивации проектов за последний час.
 *
 * Счётчик живёт в памяти процесса: это не биллинг и не аудит, а сигнал «холодный ярус
 * перестал работать». Отдельная таблица здесь была бы дороже, чем польза: после перезапуска
 * сервера история не нужна, а здоровье архивации всё равно проверяется заново.
 *
 * Хранятся только отметки времени. Текст ошибки пишется в лог вызывающим кодом: в health и
 * админ-API он не нужен, а лишние детали о путях и ключах там опасны.
 */

const WINDOW_MS = 60 * 60 * 1000;
const failures: number[] = [];

function prune(now: number) {
  const cutoff = now - WINDOW_MS;
  while (failures.length && failures[0] < cutoff) failures.shift();
}

/** Отметить неудачную архивацию. `at` нужен тестам, чтобы проверить окно в час. */
export function recordArchiveFailure(at = Date.now()) {
  failures.push(at);
  failures.sort((a, b) => a - b);
  prune(at);
}

/** Сколько неудачных архиваций было за последний час. */
export function archiveErrorsLastHour(now = Date.now()) {
  prune(now);
  return failures.length;
}

/** Только для тестов: сбросить окно. */
export function resetArchiveHealth() {
  failures.length = 0;
}
