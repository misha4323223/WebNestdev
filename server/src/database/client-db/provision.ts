import {
  ADMIN_SCHEMA_SQL,
  ADMIN_TABLE_SQL,
  LIST_TENANTS_SQL,
  ROLE_EXISTS_SQL,
  SCHEMA_SIZE_SQL,
  TENANT_BY_ACCOUNT_SQL,
  UPSERT_TENANT_SQL,
  provisionStatements,
  tenantNames,
  type TenantNames,
} from "./sql.js";
import { setTenantAccess } from "./access.js";

/**
 * Операции над клиентской базой: создание схемы аккаунта, размер данных, квота.
 *
 * Выполнение вынесено за интерфейс `SqlExecutor`, поэтому вся логика проверяется тестами без
 * настоящего PostgreSQL: тест подставляет исполнителя и смотрит, какие операторы ушли в базу.
 */
export type SqlExecutor = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

export type TenantRecord = {
  accountId: string;
  schema: string;
  role: string;
  quotaBytes: number;
  readOnly: boolean;
};

function numberFrom(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export async function ensureAdminTables(db: SqlExecutor) {
  await db.query(ADMIN_SCHEMA_SQL);
  await db.query(ADMIN_TABLE_SQL);
}

export async function roleExists(db: SqlExecutor, role: string) {
  const result = await db.query(ROLE_EXISTS_SQL, [role]);
  return result.rows.length > 0;
}

/**
 * Создаёт (или обновляет) схему и роль аккаунта. Идемпотентно: данные не удаляются, пароль
 * заменяется, лимиты выставляются заново. Квота сохраняется в учётной таблице платформы.
 */
export async function provisionTenant(
  db: SqlExecutor,
  input: { accountId: string; database: string; password: string; quotaBytes: number },
): Promise<TenantNames> {
  const names = tenantNames(input.accountId);
  await ensureAdminTables(db);
  const exists = await roleExists(db, names.role);
  const statements = provisionStatements({
    names,
    database: input.database,
    password: input.password,
    roleExists: exists,
  });
  try {
    for (const statement of statements) await db.query(statement);
  } catch (error) {
    // Если CREATE SCHEMA не удался, временное членство не должно остаться у администратора.
    // Ошибка очистки не маскирует исходную: провижининг всё равно завершится отказом.
    await db.query("REVOKE " + names.role + " FROM CURRENT_USER").catch(() => undefined);
    throw error;
  }
  await db.query(UPSERT_TENANT_SQL, [input.accountId, names.schema, names.role, input.quotaBytes]);
  // Повторный провижининг не должен оставлять роль в старом read-only: если тариф снова
  // включает базу, право записи возвращается сразу, не дожидаясь ночной проверки квот.
  const registered = await getTenant(db, input.accountId);
  // forceAccess: провижининг мог заново выдать роли CREATE/LOGIN, а таблицы после прошлого
  // исчерпания квоты остались у администратора. Состояние нужно привести к текущей квоте сразу.
  if (registered) await reconcileTenantQuota(db, registered, input.quotaBytes, { forceAccess: true });
  return names;
}

/** Байты данных схемы: таблицы и материализованные представления вместе с индексами. */
export async function tenantSizeBytes(db: SqlExecutor, schema: string): Promise<number> {
  const result = await db.query(SCHEMA_SIZE_SQL, [schema]);
  return numberFrom(result.rows[0]?.bytes);
}

export async function getTenant(db: SqlExecutor, accountId: string): Promise<TenantRecord | null> {
  const result = await db.query(TENANT_BY_ACCOUNT_SQL, [accountId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    schema: String(row.schema_name),
    role: String(row.role_name),
    quotaBytes: numberFrom(row.quota_bytes),
    readOnly: row.read_only === true,
  };
}

export async function listTenants(db: SqlExecutor): Promise<TenantRecord[]> {
  const result = await db.query(LIST_TENANTS_SQL);
  return result.rows.map(row => ({
    accountId: String(row.account_id),
    schema: String(row.schema_name),
    role: String(row.role_name),
    quotaBytes: numberFrom(row.quota_bytes),
    readOnly: row.read_only === true,
  }));
}

/**
 * Сверяет сохранённый read-only с фактическим размером схемы и текущим тарифом.
 *
 * Флаг в `nestdev_admin.tenants` мог остаться с прошлого тарифа или старой проверки.
 * Статус обязан лечить такое расхождение, иначе пустая база навсегда показывает
 * «квота исчерпана», а её роль остаётся read-only.
 */
export async function reconcileTenantQuota(
  db: SqlExecutor,
  tenant: TenantRecord,
  quotaBytes: number,
  options: { forceAccess?: boolean } = {},
): Promise<{ usedBytes: number; quotaBytes: number; readOnly: boolean }> {
  const usedBytes = await tenantSizeBytes(db, tenant.schema);
  // Нулевая квота означает «база не входит в тариф»: писать в неё нельзя, но данные не удаляем.
  const readOnly = quotaBytes <= 0 || usedBytes >= quotaBytes;
  // При read-only права проверяем каждый раз: после падения процесса или повторного
  // провижининга роль могла снова получить CREATE, а квота всё ещё исчерпана.
  if (options.forceAccess === true || readOnly !== tenant.readOnly || readOnly) {
    await setTenantAccess(db, { schema: tenant.schema, role: tenant.role }, readOnly);
  }
  // Не пишем учётную строку на каждый GET, если ни квота, ни режим не изменились.
  if (quotaBytes !== tenant.quotaBytes || readOnly !== tenant.readOnly) {
    await db.query(SET_TENANT_QUOTA_SQL, [tenant.accountId, quotaBytes, readOnly]);
  }
  return { usedBytes, quotaBytes, readOnly };
}

/** Фоновая проверка квоты: то же самое, что reconcile, для ежедневного прохода. */
export async function applyTenantQuota(
  db: SqlExecutor,
  tenant: TenantRecord,
  quotaBytes: number,
): Promise<{ usedBytes: number; quotaBytes: number; readOnly: boolean }> {
  return reconcileTenantQuota(db, tenant, quotaBytes);
}

export const SET_TENANT_QUOTA_SQL =
  "UPDATE nestdev_admin.tenants SET quota_bytes = $2, read_only = $3, updated_at = now() " +
  "WHERE account_id = $1";
