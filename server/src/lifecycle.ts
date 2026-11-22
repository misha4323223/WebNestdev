/**
 * Состояние остановки процесса. Нужно, чтобы во время выкатки сервер перестал принимать
 * новые запуски агента, но не обрывал уже начатые: их досчитывает дренаж в index.ts.
 */
let shuttingDown = false;
let reason = "";

/** Помечает процесс останавливающимся. Возвращает true только для первого вызова. */
export function beginShutdown(value: string): boolean {
  if (shuttingDown) return false;
  shuttingDown = true;
  reason = value;
  return true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function shutdownReason(): string {
  return reason;
}

/** Только для тестов: сбрасывает состояние между проверками. */
export function resetLifecycleForTests(): void {
  shuttingDown = false;
  reason = "";
}
