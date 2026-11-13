import type { PreviewStartPhase, PreviewStartProgress } from "./types.js";

/**
 * Прогресс запуска preview живёт в памяти процесса, который выполняет сам запуск. Панель
 * опрашивает статус во время долгого `preview.start`; без этого установка зависимостей и сборка
 * выглядели как зависшая кнопка, а повторный клик был единственным признаком, что что-то идёт.
 *
 * Запись не попадает в общий реестр preview: это не состояние работающего предпросмотра, а
 * короткая телеметрия текущей операции. Если статус читает другая реплика, она просто вернёт
 * обычное `running: false`, а панель всё равно покажет локальный индикатор ожидания.
 */
const active = new Map<string, PreviewStartProgress>();
const MAX_AGE_MS = 30 * 60_000;

export function beginPreviewStart(projectId: string, message = "Проверяем проект…"): void {
  const now = Date.now();
  active.set(projectId, {
    phase: "checking",
    message,
    startedAt: now,
    updatedAt: now,
  });
}

/**
 * Обновляет этап только у уже начатого запуска: функции установки и сборки вызываются и из
 * публикации/других сценариев, где никакого preview-start нет и индикатор не нужен.
 */
export function setPreviewStartProgress(
  projectId: string,
  phase: PreviewStartPhase,
  message: string,
  detail?: string,
): void {
  const current = active.get(projectId);
  if (!current) return;
  active.set(projectId, {
    ...current,
    phase,
    message,
    ...(detail ? { detail } : {}),
    updatedAt: Date.now(),
  });
}

export function getPreviewStartProgress(projectId: string, now = Date.now()): PreviewStartProgress | null {
  const current = active.get(projectId);
  if (!current) return null;
  if (now - current.updatedAt > MAX_AGE_MS) {
    active.delete(projectId);
    return null;
  }
  return { ...current };
}

export function clearPreviewStartProgress(projectId: string): void {
  active.delete(projectId);
}

/** Строка для вкладки «Логи», пока контейнера ещё нет и `docker logs` читать нечего. */
export function previewStartProgressLog(projectId: string, now = Date.now()): string {
  const current = getPreviewStartProgress(projectId, now);
  if (!current) return "";
  const elapsed = Math.max(0, Math.round((now - current.startedAt) / 1000));
  return "▸ " + current.message + (current.detail ? " · " + current.detail : "") +
    "\n  идёт " + elapsed + " с — это может занять до нескольких минут.";
}
