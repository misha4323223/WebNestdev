import { createHash } from "node:crypto";

/**
 * Имена и SQL клиентской базы.
 *
 * Схема называется по аккаунту, но не «как есть»: идентификатор проходит через хэш, поэтому
 * имя всегда валидно, не длиннее лимита PostgreSQL и не зависит от формата userId. Повторный
 * вызов для того же аккаунта даёт то же имя — провижининг идемпотентен.
 *
 * Здесь только построение SQL без выполнения: так его можно проверить тестами без базы.
 */

const IDENT = /^[a-z][a-z0-9_]{0,62}$/;
/** Пароль генерируем сами: base64url не содержит кавычек и обратных слэшей. */
const PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

export type TenantNames = { schema: string; role: string };

export function tenantNames(accountId: string): TenantNames {
  const value = (accountId ?? "").trim();
  if (!value) throw new Error("Не указан аккаунт для клиентской базы");
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const name = "tenant_" + hash;
  return { schema: name, role: name };
}

export function quoteIdent(value: string) {
  if (!IDENT.test(value)) throw new Error("Некорректный идентификатор: " + value);
  return '"' + value + '"';
}

export function quoteLiteral(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function assertPassword(value: string) {
  if (!PASSWORD.test(value)) throw new Error("Пароль клиентской базы должен быть base64url и не короче 16 символов");
}

/**
 * Полный набор DDL для аккаунта. Все операторы идемпотентны: повторный провижининг меняет
 * пароль и лимиты, но не удаляет таблицы и не пересоздаёт схему.
 */
export function provisionStatements(input: {
  names: TenantNames;
  database: string;
  password: string;
  /** Роль уже есть в базе: тогда нужен только `ALTER ROLE`. */
  roleExists: boolean;
}): string[] {
  assertPassword(input.password);
  const schema = quoteIdent(input.names.schema);
  const role = quoteIdent(input.names.role);
  const database = quoteIdent(input.database);
  const password = quoteLiteral(input.password);
  return [
    // Роль раньше схемы: `AUTHORIZATION` требует существующую роль.
    ...(input.roleExists
      ? []
      : ["CREATE ROLE " + role + " LOGIN PASSWORD " + password]),
    "ALTER ROLE " + role + " LOGIN CONNECTION LIMIT 5 PASSWORD " + password,
    // Отдельный администратор клиентской базы не superuser. `CREATE SCHEMA AUTHORIZATION tenant`
    // требует права SET ROLE на владельца схемы, поэтому даём членство ровно на время DDL и
    // снимаем его сразу после создания схемы. Так у администратора нет постоянного доступа к
    // данным тенантов, а `ALTER ROLE ... SET` ему разрешён благодаря CREATEROLE.
    "GRANT " + role + " TO CURRENT_USER",
    "CREATE SCHEMA IF NOT EXISTS " + schema + " AUTHORIZATION " + role,
    "REVOKE " + role + " FROM CURRENT_USER",
    // public в PostgreSQL 15+ не даёт PUBLIC права CREATE; отдельный REVOKE требовал бы
    // владения схемой public и ломал провижининг под отдельной ролью.
    "GRANT CONNECT ON DATABASE " + database + " TO " + role,
    "ALTER ROLE " + role + " SET search_path = " + schema + ", public",
    "ALTER ROLE " + role + " SET statement_timeout = '10s'",
    "ALTER ROLE " + role + " SET idle_in_transaction_session_timeout = '15s'",
    // temp_file_limit — SUSET-параметр: его может менять только superuser. Отдельный
    // администратор клиентской базы не должен быть superuser, поэтому этот лимит остаётся
    // на уровне сервера, а не в роли клиента.
    "ALTER ROLE " + role + " SET work_mem = '4MB'",
  ];
}

/** Роль уже существует — тогда `CREATE ROLE` не нужен, только `ALTER ROLE`. */
export const ROLE_EXISTS_SQL = "SELECT 1 FROM pg_roles WHERE rolname = $1";

/**
 * Размер данных схемы: таблицы и материализованные представления (их индексы и TOAST входят
 * в `pg_total_relation_size`). Индексы отдельно не суммируются — это было бы двойным счётом.
 */
export const SCHEMA_SIZE_SQL =
  "SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint AS bytes " +
  "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1 AND c.relkind IN ('r','m')";

export function readOnlyStatement(names: TenantNames, readOnly: boolean) {
  return "ALTER ROLE " + quoteIdent(names.role) + " SET default_transaction_read_only = " +
    (readOnly ? "on" : "off");
}

/**
 * Учётная таблица платформы внутри клиентской базы. Она нужна, чтобы фоновая проверка квот
 * обходила всех тенантов, не читая секреты проектов и не зная состава аккаунтов извне.
 */
export const ADMIN_SCHEMA_SQL = "CREATE SCHEMA IF NOT EXISTS nestdev_admin";

export const ADMIN_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS nestdev_admin.tenants (" +
  " account_id text PRIMARY KEY," +
  " schema_name text NOT NULL," +
  " role_name text NOT NULL," +
  " quota_bytes bigint NOT NULL," +
  " read_only boolean NOT NULL DEFAULT false," +
  " updated_at timestamptz NOT NULL DEFAULT now())";

export const UPSERT_TENANT_SQL =
  "INSERT INTO nestdev_admin.tenants (account_id, schema_name, role_name, quota_bytes, updated_at) " +
  "VALUES ($1, $2, $3, $4, now()) " +
  "ON CONFLICT (account_id) DO UPDATE SET schema_name = EXCLUDED.schema_name, " +
  "role_name = EXCLUDED.role_name, quota_bytes = EXCLUDED.quota_bytes, updated_at = now()";

export const SET_TENANT_READ_ONLY_SQL =
  "UPDATE nestdev_admin.tenants SET read_only = $2, updated_at = now() WHERE account_id = $1";

export const LIST_TENANTS_SQL =
  "SELECT account_id, schema_name, role_name, quota_bytes, read_only FROM nestdev_admin.tenants ORDER BY account_id";

export const TENANT_BY_ACCOUNT_SQL =
  "SELECT account_id, schema_name, role_name, quota_bytes, read_only FROM nestdev_admin.tenants WHERE account_id = $1";
