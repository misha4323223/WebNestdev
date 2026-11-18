import type { PreviewMode } from "./types.js";

/**
 * Короткая память о том, что preview остановил именно сборщик простоя, а не человек.
 *
 * После остановки строка preview удаляется, и старая ссылка видит только «не запущен». Для
 * отдельной вкладки это выглядит как поломка: контейнер исчез сам через три минуты. Отметка
 * позволяет двери показать причину — «остановлен после простоя» — и не менять общий ответ для
 * ручной остановки или упавшего контейнера.
 *
 * Память локальная: отметка нужна только на той ноде, которая остановила preview и обслуживает
 * старую ссылку. Живёт час, затем забывается; запуск preview снимает её сразу.
 */
export type IdleStopInfo = {
  mode: PreviewMode;
  idleMs: number;
  stoppedAt: number;
};

const stops = new Map<string, IdleStopInfo>();
const MAX_AGE_MS = 60 * 60_000;

export function markIdleStopped(projectId: string, mode: PreviewMode, idleMs: number, now = Date.now()): void {
  stops.set(projectId, { mode, idleMs, stoppedAt: now });
}

export function idleStopInfo(projectId: string, now = Date.now()): IdleStopInfo | null {
  const info = stops.get(projectId);
  if (!info) return null;
  if (now - info.stoppedAt > MAX_AGE_MS) {
    stops.delete(projectId);
    return null;
  }
  return { ...info };
}

export function clearIdleStop(projectId: string): void {
  stops.delete(projectId);
}

/** Тесты не должны видеть отметку, оставленную соседним сценарием. */
export function clearIdleStopsForTests(): void {
  stops.clear();
}
