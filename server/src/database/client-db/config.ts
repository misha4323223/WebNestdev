/**
 * Настройки клиентской базы платформы.
 *
 * Фича выключена, пока не заданы оба адреса: административная строка подключения и адрес,
 * который получат проекты. Так выкатка без подготовленного инстанса не ломает ничего и не
 * начинает выдавать клиентам `DATABASE_URL`, ведущий в пустоту.
 *
 * `CLIENT_DB_ADMIN_URL` — секрет: он содержит пароль администратора схем и никогда не попадает
 * ни в ответы API, ни в журнал. В лог выводится только `describeClientDatabase()`.
 */
export type ClientDatabaseConfig = {
  /** Строка администратора (DDL): схема, роль, права. Не логируется и не отдаётся клиенту. */
  adminUrl: string;
  /** Хост в `DATABASE_URL` клиента — адрес PgBouncer, а не PostgreSQL. */
  host: string;
  port: number;
  /** Имя общей базы, в которой живут схемы аккаунтов. */
  database: string;
  /** TLS обязателен по умолчанию: строка клиента уходит в контейнер функции. */
  ssl: boolean;
};

function positiveInt(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : fallback;
}

/** Разбирает окружение. `null` — клиентская база на этой установке не включена. */
export function clientDatabaseConfig(env: NodeJS.ProcessEnv = process.env): ClientDatabaseConfig | null {
  const adminUrl = (env.CLIENT_DB_ADMIN_URL ?? "").trim();
  const host = (env.CLIENT_DB_PUBLIC_HOST ?? "").trim();
  if (!adminUrl || !host) return null;
  if (!/^postgres(ql)?:\/\//i.test(adminUrl)) {
    throw new Error("CLIENT_DB_ADMIN_URL должен начинаться с postgres:// или postgresql://");
  }
  if (/[\s/]/.test(host)) throw new Error("CLIENT_DB_PUBLIC_HOST — это имя хоста без схемы и пути");
  return {
    adminUrl,
    host,
    port: positiveInt(env.CLIENT_DB_PORT, 6432),
    database: (env.CLIENT_DB_NAME ?? "").trim() || "app",
    // Отключить TLS можно только явно: `CLIENT_DB_SSL=0` для локальной проверки.
    ssl: (env.CLIENT_DB_SSL ?? "").trim() !== "0",
  };
}

/** Строка для старта сервера: без пароля и без полной строки подключения. */
export function describeClientDatabase(config: ClientDatabaseConfig | null): string {
  if (!config) return "клиентская база: выключена (нет CLIENT_DB_ADMIN_URL/CLIENT_DB_PUBLIC_HOST)";
  return "клиентская база: " + config.host + ":" + config.port + "/" + config.database +
    (config.ssl ? ", TLS" : ", без TLS");
}
