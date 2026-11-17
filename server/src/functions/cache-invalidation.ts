import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { listenPostgresNotifications, type PostgresNotificationLogger } from "../storage/pg-notifications.js";
import { functionResponseCache } from "./response-cache.js";

/**
 * Инвалидация ответного кеша функций на всех нодах.
 *
 * Локальный сброс делается сразу и не зависит от базы. В PostgreSQL дополнительно уходит
 * `pg_notify`: другие процессы слушают канал и сбрасывают только этот сайт. JSON-режим
 * остаётся локальным — там одна машина и общий процесс, поэтому уведомление не нужно.
 *
 * Ошибка уведомления не отменяет публикацию или изменение контента: локальный кеш уже
 * очищен, а TTL остаётся страховкой. Вызывающий код получает причину и решает, писать ли её.
 */

const CACHE_CHANNEL = "function_cache";

export function functionCacheInvalidationChannel() {
  return getTable(CACHE_CHANNEL);
}

export type FunctionCacheInvalidationResult = {
  /** Локальный экземпляр очищен. */
  local: true;
  /** Уведомление другим нодам отправлено. */
  notified: boolean;
  /** Почему уведомление не ушло; локальный сброс при этом всё равно выполнен. */
  error?: string;
};

export type FunctionCacheInvalidationDeps = {
  clearSite?: (siteId: string) => void;
  notify?: (siteId: string) => Promise<void>;
};

async function notifyOtherNodes(siteId: string) {
  await ydbQuery()`SELECT pg_notify(${functionCacheInvalidationChannel()}, ${siteId})`;
}

export async function invalidateFunctionCache(
  siteId: string,
  deps: FunctionCacheInvalidationDeps = {},
): Promise<FunctionCacheInvalidationResult> {
  (deps.clearSite ?? (id => functionResponseCache.clearSite(id)))(siteId);

  if (!isYdbEnabled() && !deps.notify) {
    return { local: true, notified: false, error: "storage-json" };
  }
  const notify = deps.notify ?? notifyOtherNodes;
  try {
    await notify(siteId);
    return { local: true, notified: true };
  } catch (error) {
    return {
      local: true,
      notified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let listener: Awaited<ReturnType<typeof listenPostgresNotifications>> = null;

/**
 * Запускается после инициализации хранилища. В JSON-режиме и при выключенном кеше ничего
 * не делает. Повторный вызов безопасен.
 */
export async function startFunctionCacheInvalidation(
  log: PostgresNotificationLogger = () => undefined,
): Promise<boolean> {
  if (listener) return true;
  if (!isYdbEnabled() || !functionResponseCache.enabled) return false;
  listener = await listenPostgresNotifications({
    channel: functionCacheInvalidationChannel(),
    onPayload: siteId => functionResponseCache.clearSite(siteId),
    log,
  });
  return listener !== null;
}

export async function stopFunctionCacheInvalidation() {
  const current = listener;
  listener = null;
  if (current) await current.close();
}

/** Для health и тестов: слушатель действительно подключён в этом процессе. */
export function functionCacheInvalidationActive() {
  return listener !== null;
}
