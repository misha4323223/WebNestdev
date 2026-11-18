import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { databaseLimitFor, PLAN_CATALOG, type PlanId } from "../../account/plans.js";
import {
  deleteProjectSecret,
  listProjectSecrets,
  saveProjectSecrets,
} from "../../secrets/project-secrets.js";
import { clientDatabaseConfig, type ClientDatabaseConfig } from "./config.js";
import {
  applyTenantQuota,
  getTenant,
  listTenants,
  provisionTenant,
  tenantSizeBytes,
  type SqlExecutor,
  type TenantRecord,
} from "./provision.js";
import { tenantNames } from "./sql.js";

/**
 * Клиентская база платформы: выдача, состояние и отключение.
 *
 * Пароль схемы генерируется заново при каждом подключении и сразу уходит в зашифрованное
 * хранилище секретов проекта. Наружу (в интерфейс и модели) отдаётся только маска адреса:
 * полная строка подключения — секрет, как и любой другой ключ проекта.
 */

export const CLIENT_DB_SECRET_FILE = ".env.local";
export const CLIENT_DB_SECRET_NAME = "DATABASE_URL";

export class ClientDatabaseError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(message: string, statusCode = 400, code = "CLIENT_DATABASE_ERROR") {
    super(message);
    this.name = "ClientDatabaseError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

let pool: Pool | null = null;

/**
 * Пул администратора нужен только для DDL и проверки размеров: держим максимум два соединения.
 * Ошибка простаивающего соединения не должна ронять API, поэтому у пула есть обработчик.
 */
export function adminExecutor(config: ClientDatabaseConfig): SqlExecutor {
  if (!pool) {
    pool = new Pool({
      connectionString: config.adminUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    pool.on("error", error => {
      console.warn("[client-db] соединение администратора закрылось с ошибкой: " + error.message);
    });
  }
  return pool;
}

/** Для тестов и корректного завершения процесса. */
export async function closeClientDatabasePool() {
  const current = pool;
  pool = null;
  if (current) await current.end().catch(() => undefined);
}

export function clientDatabaseUrl(
  config: Pick<ClientDatabaseConfig, "host" | "port" | "database" | "ssl">,
  role: string,
  password: string,
) {
  const auth = encodeURIComponent(role) + ":" + encodeURIComponent(password);
  const query = config.ssl ? "?sslmode=require" : "";
  return "postgres://" + auth + "@" + config.host + ":" + config.port + "/" +
    encodeURIComponent(config.database) + query;
}

/** Маска для интерфейса и ответов модели: пароля в ней нет. */
export function maskClientDatabaseUrl(
  config: Pick<ClientDatabaseConfig, "host" | "port" | "database">,
  role: string,
) {
  return "postgres://" + role + ":***@" + config.host + ":" + config.port + "/" + config.database;
}

export type ClientDatabaseStatus =
  | { available: false; reason: string }
  | {
      available: true;
      reachable: boolean;
      provisioned: boolean;
      role: string;
      maskedUrl: string;
      usedBytes: number;
      limitBytes: number;
      readOnly: boolean;
      error?: string;
    };

function requireConfig() {
  const config = clientDatabaseConfig();
  if (!config) {
    throw new ClientDatabaseError(
      "Клиентская база на этой установке не включена: не заданы CLIENT_DB_ADMIN_URL и CLIENT_DB_PUBLIC_HOST.",
      503,
      "CLIENT_DATABASE_NOT_CONFIGURED",
    );
  }
  return config;
}

function planDatabaseLimit(plan: PlanId) {
  const limit = databaseLimitFor(plan);
  if (limit <= 0) {
    throw new ClientDatabaseError(
      "Клиентская база входит в тарифы «Плюс» (128 МБ) и «Премиум» (512 МБ). На тарифе «" +
        PLAN_CATALOG[plan].name + "» её нет.",
      403,
      "DATABASE_PLAN_REQUIRED",
    );
  }
  return limit;
}

/**
 * Подключает базу к проекту: создаёт схему аккаунта (если её ещё нет), обновляет пароль и
 * записывает `DATABASE_URL` в зашифрованное хранилище проекта. Возвращает только маску.
 */
export async function connectClientDatabase(input: {
  userId: string;
  projectId: string;
  root: string;
  plan: PlanId;
}) {
  const config = requireConfig();
  const limitBytes = planDatabaseLimit(input.plan);
  const password = randomBytes(24).toString("base64url");
  const names = tenantNames(input.userId);
  let namesFromBase: { schema: string; role: string };
  try {
    namesFromBase = await provisionTenant(adminExecutor(config), {
      accountId: input.userId,
      database: config.database,
      password,
      quotaBytes: limitBytes,
    });
  } catch (error) {
    throw new ClientDatabaseError(
      "Не удалось создать базу: " + (error instanceof Error ? error.message : String(error)),
      503,
      "CLIENT_DATABASE_PROVISION_FAILED",
    );
  }
  const url = clientDatabaseUrl(config, namesFromBase.role, password);
  await saveProjectSecrets(input.projectId, input.root, { [CLIENT_DB_SECRET_NAME]: url }, CLIENT_DB_SECRET_FILE);
  return {
    ok: true as const,
    role: namesFromBase.role,
    schema: namesFromBase.schema,
    maskedUrl: maskClientDatabaseUrl(config, namesFromBase.role),
    file: CLIENT_DB_SECRET_FILE,
    limitBytes,
    note:
      "Строка подключения сохранена в зашифрованном хранилище проекта как DATABASE_URL. " +
      "Читайте её из process.env.DATABASE_URL; значение не печатайте.",
  };
}

/** Состояние базы проекта: включена ли фича, есть ли схема, сколько занято и какая квота. */
export async function clientDatabaseStatus(input: {
  userId: string;
  projectId: string;
  root: string;
  plan: PlanId;
}): Promise<ClientDatabaseStatus> {
  const config = clientDatabaseConfig();
  if (!config) {
    return { available: false, reason: "Клиентская база на этой установке не включена" };
  }
  const names = tenantNames(input.userId);
  const secrets = await listProjectSecrets(input.projectId, input.root).catch(() => []);
  const provisioned = secrets.some(item => item.name === CLIENT_DB_SECRET_NAME);
  const limitBytes = databaseLimitFor(input.plan);
  let tenant: TenantRecord | null = null;
  let usedBytes = 0;
  try {
    const db = adminExecutor(config);
    tenant = await getTenant(db, input.userId);
    if (tenant) usedBytes = await tenantSizeBytes(db, tenant.schema);
  } catch (error) {
    return {
      available: true,
      reachable: false,
      provisioned,
      role: names.role,
      maskedUrl: maskClientDatabaseUrl(config, names.role),
      usedBytes: 0,
      limitBytes,
      readOnly: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    available: true,
    reachable: true,
    provisioned,
    role: tenant?.role ?? names.role,
    maskedUrl: maskClientDatabaseUrl(config, tenant?.role ?? names.role),
    usedBytes,
    limitBytes,
    // Read-only включает либо фактическое превышение, либо тариф без базы.
    readOnly: Boolean(tenant?.readOnly) || limitBytes <= 0 || usedBytes >= limitBytes,
  };
}

/** Убирает `DATABASE_URL` из проекта. Схема и данные остаются: база принадлежит аккаунту. */
export async function disconnectClientDatabase(input: { projectId: string; root: string }) {
  const result = await deleteProjectSecret(input.projectId, input.root, CLIENT_DB_SECRET_NAME, CLIENT_DB_SECRET_FILE);
  return {
    ok: true as const,
    removed: result.deleted,
    note: "Схема и данные аккаунта не удалены — они принадлежат аккаунту, а не проекту.",
  };
}

/**
 * Фоновая проверка квот: обходит учётную таблицу и приводит read-only в соответствие с тарифом.
 * Вызывается скриптом `client-db-quota.ts`; здесь остаётся только логика, без расписания.
 */
export async function applyClientDatabaseQuotas(planFor: (accountId: string) => Promise<PlanId>) {
  const config = requireConfig();
  const db = adminExecutor(config);
  const tenants = await listTenants(db);
  const results: Array<{ accountId: string; usedBytes: number; quotaBytes: number; readOnly: boolean }> = [];
  for (const tenant of tenants) {
    const plan = await planFor(tenant.accountId).catch(() => "free" as PlanId);
    const quotaBytes = databaseLimitFor(plan);
    const applied = await applyTenantQuota(db, tenant, quotaBytes);
    results.push({ accountId: tenant.accountId, ...applied });
  }
  return { checked: results.length, results };
}
