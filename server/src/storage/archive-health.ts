/**
 * Ошибки и итоги архивации проектов.
 *
 * Счётчики живут в памяти процесса: это не биллинг и не аудит, а сигнал «холодный ярус
 * перестал работать». Отдельная таблица здесь была бы дороже, чем польза: после перезапуска
 * сервера история не нужна, а здоровье архивации всё равно проверяется заново.
 *
 * Хранятся только отметки времени и агрегаты. Текст ошибки пишется в лог вызывающим кодом:
 * в health и админ-API он не нужен, а лишние детали о путях и ключах там опасны.
 */

const WINDOW_MS = 60 * 60 * 1000;
const failures: number[] = [];

/** Итог одного прохода: его видно в `/api/health` и в строке лога. */
export type ArchiveRunReport = {
  mode: "idle" | "pressure";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  candidates: number;
  archived: number;
  skipped: number;
  deferred: number;
  failed: number;
  bytesFreed: number;
  diskBefore: number | null;
  diskAfter: number | null;
  targetPercent: number | null;
  targetReached: boolean | null;
};

type ArchiveTotals = {
  archived: number;
  failed: number;
  bytesFreed: number;
  runs: number;
  durationMs: number;
};

const totals: ArchiveTotals = { archived: 0, failed: 0, bytesFreed: 0, runs: 0, durationMs: 0 };
let lastRun: ArchiveRunReport | null = null;

function prune(now: number) {
  const cutoff = now - WINDOW_MS;
  while (failures.length && failures[0] < cutoff) failures.shift();
}

/** Отметить неудачную архивацию. `at` нужен тестам, чтобы проверить окно в час. */
export function recordArchiveFailure(at = Date.now()) {
  failures.push(at);
  failures.sort((a, b) => a - b);
  prune(at);
  totals.failed += 1;
}

/** Сколько неудачных архиваций было за последний час. */
export function archiveErrorsLastHour(now = Date.now()) {
  prune(now);
  return failures.length;
}

/** Записать итог прохода. Вызывается планировщиком после каждого обхода. */
export function recordArchiveRun(report: ArchiveRunReport) {
  totals.archived += report.archived;
  totals.bytesFreed += report.bytesFreed;
  totals.runs += 1;
  totals.durationMs += report.durationMs;
  lastRun = report;
}

/**
 * Снимок для `/api/health`. `errorsLastHour` — окно, по которому бьёт алерт; остальные числа
 * накоплены с запуска процесса и отвечают на вопрос «что и сколько сделал холодный ярус».
 */
export function archiveStats(now = Date.now()) {
  return {
    errorsLastHour: archiveErrorsLastHour(now),
    archivedSinceStart: totals.archived,
    failedSinceStart: totals.failed,
    bytesFreedSinceStart: totals.bytesFreed,
    runsSinceStart: totals.runs,
    averageRunMs: totals.runs ? Math.round(totals.durationMs / totals.runs) : 0,
    lastRun,
  };
}

/** Только для тестов: сбросить окно и накопленные итоги. */
export function resetArchiveHealth() {
  failures.length = 0;
  totals.archived = 0;
  totals.failed = 0;
  totals.bytesFreed = 0;
  totals.runs = 0;
  totals.durationMs = 0;
  lastRun = null;
}
