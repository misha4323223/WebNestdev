import type { Pool, PoolClient } from "pg";

/** Один и тот же ключ во всех процессах: DDL выполняет только один инициализатор. */
const STORAGE_INIT_LOCK = "webnestdev:storage-init";

export type StorageInitLock = {
  /** Снять лок и вернуть соединение. Повторный вызов безопасен. */
  release: () => Promise<void>;
};

/**
 * Блокирующий advisory-лок на всё время инициализации схемы.
 *
 * Соединение выделяется намеренно: `pool.query` мог бы взять другой коннект, а advisory-лок
 * живёт только на своём. Если запрос лока не прошёл, соединение возвращается сразу, иначе
 * ошибка старта утекала бы одним занятым клиентом пула. Падение процесса освобождает лок
 * вместе с соединением, поэтому отдельный таймаут не нужен.
 */
export async function acquireStorageInitLock(pool: Pick<Pool, "connect">): Promise<StorageInitLock> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [STORAGE_INIT_LOCK]);
  } catch (error) {
    client.release();
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [STORAGE_INIT_LOCK])
        .catch(() => undefined);
      client.release();
    },
  };
}
