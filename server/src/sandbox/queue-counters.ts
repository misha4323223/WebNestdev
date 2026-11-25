/**
 * Отказы очереди песочницы — только для `/metrics`, в интерфейс они не попадают.
 *
 * Место в очереди человеку не показывается: ожидание — внутренняя механика платформы (см.
 * `agent/wait-activity.ts`). Но эксплуатации нужно видеть перегрузку: сколько команд не получило
 * контейнер, потому что очередь была заполнена, и сколько не дождалось места по таймауту. Это и
 * есть разница между «машина медленная» и «мест физически не хватает».
 *
 * Модуль намеренно без зависимостей: его читает `/metrics`, и он не должен тянуть за собой
 * биллинг и хранилище.
 */

let queueFull = 0;
let waitTimedOut = 0;

export function noteSandboxQueueFull() {
  queueFull++;
}

export function noteSandboxWaitTimedOut() {
  waitTimedOut++;
}

export function sandboxQueueRejections() {
  return { queueFull, waitTimedOut };
}

/** Для тестов: между проверками счётчики должны начинаться с нуля. */
export function resetSandboxQueueRejections() {
  queueFull = 0;
  waitTimedOut = 0;
}
