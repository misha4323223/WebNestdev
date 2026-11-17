import { Client } from "pg";
import { isYdbEnabled } from "./pg.js";

/**
 * Слушатель LISTEN/NOTIFY для межпроцессной инвалидации.
 *
 * Это отдельное долгоживущее соединение, а не клиент из pool: `LISTEN` привязан к сессии,
 * и pool мог бы отдать следующий запрос уже другому соединению. PostgreSQL — не очередь
 * задач: уведомление не сохраняется, если слушатель был отключён. Поэтому кеш всё равно
 * ограничен TTL, а этот слой только сокращает окно старого ответа.
 */

export type PostgresNotificationLogger = (level: "info" | "warn", message: string) => void;

export type PostgresNotificationHandle = {
  channel: string;
  close: () => Promise<void>;
};

export type PostgresNotificationOptions = {
  channel: string;
  onPayload: (payload: string) => void;
  connectionString?: string;
  log?: PostgresNotificationLogger;
  reconnectDelayMs?: number;
};

/** Имя канала — SQL-идентификатор, а не пользовательская строка. */
export function assertNotificationChannel(channel: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel)) {
    throw new Error("Некорректное имя канала PostgreSQL: " + channel);
  }
  return channel;
}

/**
 * Подключается и начинает слушать канал. Первое подключение ошибкой возвращается
 * вызывающему; после успешного старта обрыв переподключается в фоне.
 */
export async function listenPostgresNotifications(
  options: PostgresNotificationOptions,
): Promise<PostgresNotificationHandle | null> {
  if (!isYdbEnabled()) return null;
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL notifications");
  const channel = assertNotificationChannel(options.channel);
  const log = options.log ?? (() => undefined);
  const reconnectDelayMs = Math.max(1_000, options.reconnectDelayMs ?? 5_000);

  let stopped = false;
  let ready = false;
  let client: Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(error => {
        log("warn", "function cache invalidation reconnect failed: " + errorMessage(error));
        scheduleReconnect();
      });
    }, reconnectDelayMs);
    reconnectTimer.unref();
  };

  const connect = async () => {
    if (stopped) return;
    const current = new Client({ connectionString });
    client = current;
    current.on("notification", message => {
      if (message.channel !== channel) return;
      const payload = message.payload?.trim();
      if (!payload || payload.includes("\0") || payload.length > 200) return;
      try {
        options.onPayload(payload);
      } catch (error) {
        log("warn", "function cache invalidation handler failed: " + errorMessage(error));
      }
    });
    current.on("error", error => {
      log("warn", "function cache invalidation connection error: " + errorMessage(error));
    });
    current.on("end", () => {
      if (client === current) client = null;
      if (ready) scheduleReconnect();
    });
    try {
      await current.connect();
      await current.query(`LISTEN "${channel}"`);
      ready = true;
      log("info", "function cache invalidation listening on " + channel);
    } catch (error) {
      if (client === current) client = null;
      await current.end().catch(() => undefined);
      if (!ready) throw error;
      log("warn", "function cache invalidation reconnect failed: " + errorMessage(error));
      scheduleReconnect();
    }
  };

  await connect();

  return {
    channel,
    close: async () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const current = client;
      client = null;
      if (current) await current.end().catch(() => undefined);
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
