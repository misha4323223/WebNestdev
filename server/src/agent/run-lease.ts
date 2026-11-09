import { randomUUID } from "node:crypto";
import { nodeId } from "../nodes/identity.js";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/pg.js";

/**
 * Межрепликантная аренда запуска агента.
 *
 * Локальная `Map` в `run-limiter.ts` остаётся быстрым предохранителем процесса, но вторая
 * реплика API её не видит: два таба одного аккаунта могли попасть на разные ВМ и запустить два
 * агента. Аренда в PostgreSQL закрывает это без удержания соединения на весь прогон — строка
 * продлевается heartbeat-ом и истекает после падения процесса.
 */

export type RunLease = {
  /** Снять аренду. Повторный вызов безопасен. */
  release: () => Promise<void>;
  /** Продлить аренду вручную; штатно это делает таймер. */
  heartbeat: () => Promise<void>;
};

export type RunLeaseResult =
  | { kind: "acquired"; lease: RunLease }
  | { kind: "busy" }
  | { kind: "aborted" }
  | { kind: "disabled" };

export type RunLeaseBackend = {
  enabled: () => boolean;
  tryAcquire: (input: {
    userId: string;
    runId: string;
    projectId: string;
    now: number;
    expiresAt: number;
  }) => Promise<boolean>;
  heartbeat: (input: {
    userId: string;
    runId: string;
    expiresAt: number;
  }) => Promise<boolean>;
  release: (input: { userId: string; runId: string }) => Promise<void>;
  /** Есть ли непросроченный запуск этого проекта на любой реплике. */
  projectActive: (projectId: string, now: number) => Promise<boolean>;
};

/** Сколько живёт аренда без heartbeat. */
export function runLeaseTtlMs(): number {
  const raw = process.env.RUN_LEASE_TTL_MS?.trim();
  if (!raw) return 120_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 10_000 ? Math.floor(parsed) : 120_000;
}

/** Как часто продлевать аренду; по умолчанию треть TTL, чтобы два пропуска не теряли запуск. */
export function runLeaseHeartbeatMs(ttl = runLeaseTtlMs()): number {
  const raw = process.env.RUN_LEASE_HEARTBEAT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1_000) return Math.min(Math.floor(parsed), Math.floor(ttl / 2));
  }
  return Math.max(1_000, Math.floor(ttl / 3));
}

const postgresBackend: RunLeaseBackend = {
  enabled: () => isYdbEnabled(),
  async tryAcquire(input) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("run_leases"));
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      INSERT INTO ${table} (user_id, run_id, project_id, node, expires_at, updated_at)
      VALUES (${input.userId}, ${input.runId}, ${input.projectId}, ${nodeId()}, ${input.expiresAt}, ${input.now})
      ON CONFLICT (user_id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        project_id = EXCLUDED.project_id,
        node = EXCLUDED.node,
        expires_at = EXCLUDED.expires_at,
        updated_at = EXCLUDED.updated_at
      WHERE ${table}.expires_at <= ${input.now}
      RETURNING user_id`;
    return rows.length > 0;
  },
  async heartbeat(input) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("run_leases"));
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      UPDATE ${table}
         SET expires_at = ${input.expiresAt}, updated_at = ${Date.now()}
       WHERE user_id = ${input.userId} AND run_id = ${input.runId}
       RETURNING user_id`;
    return rows.length > 0;
  },
  async release(input) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("run_leases"));
    await ydbQuery()`
      DELETE FROM ${table}
       WHERE user_id = ${input.userId} AND run_id = ${input.runId}`;
  },
  async projectActive(projectId, now) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("run_leases"));
    const [rows] = await ydbQuery()<Array<{ user_id: string }>>`
      SELECT user_id FROM ${table}
       WHERE project_id = ${projectId} AND expires_at > ${now}
       LIMIT 1`;
    return rows.length > 0;
  },
};

let backend: RunLeaseBackend = postgresBackend;

/** Подмена для unit-тестов: настоящий PostgreSQL в них не поднимается. */
export function setRunLeaseBackendForTests(next: RunLeaseBackend | null): void {
  backend = next ?? postgresBackend;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function createLease(userId: string, runId: string): RunLease {
  let released = false;
  let heartbeatInFlight: Promise<void> | null = null;

  const heartbeat = async () => {
    if (released) return;
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = (async () => {
      try {
        const extended = await backend.heartbeat({
          userId,
          runId,
          expiresAt: Date.now() + runLeaseTtlMs(),
        });
        if (!extended) {
          console.warn("[agent] аренда запуска " + userId + " больше не принадлежит этому процессу");
        }
      } catch (error) {
        // Сеть до базы могла моргнуть: следующий heartbeat попробует снова, а TTL даёт запас.
        console.warn("[agent] не удалось продлить аренду запуска: " + describeError(error));
      }
    })().finally(() => {
      heartbeatInFlight = null;
    });
    return heartbeatInFlight;
  };

  const timer = setInterval(() => void heartbeat(), runLeaseHeartbeatMs());
  timer.unref();

  return {
    heartbeat,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        await backend.release({ userId, runId });
      } catch (error) {
        // Аренда истечёт по TTL. Ошибка release не должна маскировать исход самого запуска.
        console.warn("[agent] не удалось снять аренду запуска: " + describeError(error));
      }
    },
  };
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Пытается взять аренду аккаунта. `waitMs` повторяет прежнее поведение `AGENT_ACCOUNT_WAIT_MS`:
 * отменённый прогон отпускает место за миллисекунды, и новый запрос не должен получать отказ.
 */
export async function acquireRunLease(
  userId: string,
  options: { signal: AbortSignal; waitMs: number; projectId?: string },
): Promise<RunLeaseResult> {
  if (!userId.trim() || !backend.enabled()) return { kind: "disabled" };
  const runId = randomUUID();
  const deadline = Date.now() + Math.max(0, options.waitMs);
  while (true) {
    if (options.signal.aborted) return { kind: "aborted" };
    let acquired = false;
    try {
      const now = Date.now();
      acquired = await backend.tryAcquire({
        userId,
        runId,
        projectId: options.projectId ?? "",
        now,
        expiresAt: now + runLeaseTtlMs(),
      });
    } catch (error) {
      // Если реестр недоступен, не блокируем все запуски платформы: локальное правило продолжает
      // работать. Это ослабление на время сбоя базы, а не постоянный режим.
      console.warn("[agent] аренда запуска недоступна, остаюсь на локальном лимите: " + describeError(error));
      return { kind: "disabled" };
    }
    if (acquired) return { kind: "acquired", lease: createLease(userId, runId) };
    if (Date.now() >= deadline) return { kind: "busy" };
    await wait(Math.min(200, deadline - Date.now()), options.signal);
  }
}

/** Активный запуск проекта на любой реплике; в JSON-режиме всегда false. */
export async function isProjectRunLeaseActive(projectId: string): Promise<boolean> {
  if (!projectId.trim() || !backend.enabled()) return false;
  try {
    return await backend.projectActive(projectId, Date.now());
  } catch (error) {
    // Недоступная база не должна превращать архивацию в вечный отказ; локальная проверка
    // `isRunActive` всё равно остаётся. Это тот же fail-open, что и у самой аренды.
    console.warn("[agent] не удалось проверить активность проекта: " + describeError(error));
    return false;
  }
}

