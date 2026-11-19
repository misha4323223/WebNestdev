import { randomUUID } from "node:crypto";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/pg.js";

/**
 * Журнал холодных стартов предпросмотра за 24 часа.
 *
 * В отличие от `preview-metrics.ts`, который отвечает на вопрос «не тормозит ли узел прямо
 * сейчас» и живёт 30 минут в памяти, здесь нужен суточный счётчик для админки. В production
 * запуски пишутся в PostgreSQL, поэтому цифры общие для обеих реплик и переживают рестарт API.
 * В JSON-режиме остаётся память процесса — это честное ограничение локальной установки, а не
 * повод показывать ноль вместо данных.
 *
 * Пишутся только runtime-запуски (`container` и `hybrid`): статический preview — это сборка и
 * слушатель в процессе сервера, а не остановленный контейнер, который поднимают при первом
 * запросе агента. Неудачные запуски тоже не считаются стартом: их видно в `preview-metrics` как
 * `failures`, а среднее время старта не должно раздуваться из-за ошибки сборки.
 */

export type PreviewStartMode = "container" | "hybrid";

export type PreviewStartEvent = {
  id: string;
  projectId: string;
  node: string;
  mode: PreviewStartMode;
  durationMs: number;
  ok: boolean;
  startedAt: number;
};

export type PreviewStartJournalSummary = {
  /** Успешные runtime-старты за окно. */
  count: number;
  averageMs: number | null;
  slowestMs: number | null;
  /** Последний успешный старт каждого проекта — для `startMs` в списке песочниц. */
  latestByProject: Map<string, { durationMs: number; startedAt: number }>;
  /** Начало самого старого сохранённого события; null, если событий нет. */
  since: number | null;
  source: "postgres" | "memory";
};

type JournalRow = {
  id: string;
  project_id: string | null;
  node: string | null;
  mode: string | null;
  duration_ms: number | string | null;
  ok: boolean | string | null;
  started_at: number | string | null;
};

const WINDOW_MS = 24 * 60 * 60_000;
const MAX_MEMORY_EVENTS = 5_000;
const memory: PreviewStartEvent[] = [];
let persistenceWarned = false;

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function boolean(value: unknown): boolean {
  return value === true || value === "true" || value === "t" || value === 1 || value === "1";
}

function eventOf(row: Partial<PreviewStartEvent>): PreviewStartEvent | null {
  const startedAt = integer(row.startedAt);
  const projectId = String(row.projectId ?? "").trim();
  if (!startedAt || !projectId) return null;
  const mode: PreviewStartMode = row.mode === "hybrid" ? "hybrid" : "container";
  return {
    id: String(row.id ?? randomUUID()),
    projectId,
    node: String(row.node ?? "").trim() || "local",
    mode,
    durationMs: Math.max(0, integer(row.durationMs)),
    ok: row.ok === true,
    startedAt,
  };
}

function pruneMemory(now: number) {
  const cutoff = now - WINDOW_MS;
  while (memory.length && (memory[0]?.startedAt ?? 0) < cutoff) memory.shift();
  while (memory.length > MAX_MEMORY_EVENTS) memory.shift();
}

function rowEvent(row: JournalRow): PreviewStartEvent | null {
  return eventOf({
    id: String(row.id ?? ""),
    projectId: String(row.project_id ?? ""),
    node: String(row.node ?? ""),
    mode: row.mode === "hybrid" ? "hybrid" : "container",
    durationMs: integer(row.duration_ms),
    ok: boolean(row.ok),
    startedAt: integer(row.started_at),
  });
}

/** Чистая часть: одинаково считает и строки PostgreSQL, и события памяти. */
export function summarizePreviewStarts(
  events: PreviewStartEvent[],
  now = Date.now(),
  source: PreviewStartJournalSummary["source"] = "memory",
): PreviewStartJournalSummary {
  const cutoff = now - WINDOW_MS;
  const latestByProject = new Map<string, { durationMs: number; startedAt: number }>();
  let count = 0;
  let total = 0;
  let slowest = 0;
  let since: number | null = null;

  for (const event of events) {
    if (event.startedAt < cutoff || event.startedAt > now) continue;
    since = since === null ? event.startedAt : Math.min(since, event.startedAt);
    if (!event.ok) continue;
    count += 1;
    total += Math.max(0, Math.round(event.durationMs));
    slowest = Math.max(slowest, Math.max(0, Math.round(event.durationMs)));
    const previous = latestByProject.get(event.projectId);
    if (!previous || event.startedAt > previous.startedAt) {
      latestByProject.set(event.projectId, {
        durationMs: Math.max(0, Math.round(event.durationMs)),
        startedAt: event.startedAt,
      });
    }
  }

  return {
    count,
    averageMs: count > 0 ? Math.round(total / count) : null,
    slowestMs: count > 0 ? slowest : null,
    latestByProject,
    since,
    source,
  };
}

async function persist(event: PreviewStartEvent) {
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("preview_starts"));
  await ydbQuery()`
    INSERT INTO ${table} (id, project_id, node, mode, duration_ms, ok, started_at)
    VALUES (${event.id}, ${event.projectId}, ${event.node}, ${event.mode}, ${event.durationMs}, ${event.ok}, ${event.startedAt})
  `;
}

/**
 * Запоминает старт. Память обновляется сразу, PostgreSQL — в фоне: старт предпросмотра не должен
 * ждать ещё один запрос к базе, а админка через несколько секунд уже увидит строку.
 */
export function notePreviewStart(input: {
  projectId: string;
  node: string;
  mode: PreviewStartMode;
  durationMs: number;
  ok: boolean;
  startedAt?: number;
}): void {
  const now = input.startedAt ?? Date.now();
  const event = eventOf({
    id: randomUUID(),
    projectId: input.projectId,
    node: input.node,
    mode: input.mode,
    durationMs: input.durationMs,
    ok: input.ok,
    startedAt: now,
  });
  if (!event) return;
  memory.push(event);
  pruneMemory(now);
  if (!isYdbEnabled()) return;

  void persist(event).catch(error => {
    if (persistenceWarned) return;
    persistenceWarned = true;
    console.warn(
      "[preview] журнал стартов не записан в PostgreSQL: " +
        (error instanceof Error ? error.message : String(error)) +
        " — до конца процесса админка увидит только старты этой реплики",
    );
  });
}

async function readPostgres(now: number): Promise<PreviewStartEvent[]> {
  if (!isYdbEnabled()) return [];
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("preview_starts"));
  const cutoff = now - WINDOW_MS;
  // Храним только сутки: иначе таблица росла бы вместе с числом запусков навсегда.
  await ydbQuery()`DELETE FROM ${table} WHERE started_at < ${cutoff}`;
  const [rows] = await ydbQuery()<JournalRow[]>`
    SELECT id, project_id, node, mode, duration_ms, ok, started_at
      FROM ${table}
     WHERE started_at >= ${cutoff} AND started_at <= ${now}
  `;
  return rows.map(rowEvent).filter((event): event is PreviewStartEvent => event !== null);
}

/**
 * Сводка за 24 часа. Если PostgreSQL недоступен, возвращается память процесса — это лучше, чем
 * `null` в админке, но `source` показывает, что цифры неполные.
 */
export async function previewStartJournal(now = Date.now()): Promise<PreviewStartJournalSummary> {
  pruneMemory(now);
  if (!isYdbEnabled()) return summarizePreviewStarts(memory, now, "memory");
  try {
    const events = await readPostgres(now);
    const known = new Set(events.map(event => event.id));
    for (const event of memory) {
      if (event.startedAt >= now - WINDOW_MS && !known.has(event.id)) events.push(event);
    }
    return summarizePreviewStarts(events, now, "postgres");
  } catch {
    return summarizePreviewStarts(memory, now, "memory");
  }
}

/** Тесты и смена режима хранилища начинают с пустого журнала. */
export function resetPreviewStartJournalForTests(): void {
  memory.length = 0;
  persistenceWarned = false;
}
