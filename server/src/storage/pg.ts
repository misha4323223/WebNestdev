import path from "node:path";
import { Pool } from "pg";

/**
 * PostgreSQL storage backend — API-совместим с прежним YDB-модулем.
 *
 * Потребители используют:
 *   const [rows] = await ydbQuery()<T>`SELECT ...`   — generic call, T = тип результата (обычно Array<Row>)
 *   ydbQuery().identifier(tableName)
 *   ydbQuery().transaction(opts, async tx => { await tx`INSERT ...` })
 *   isYdbEnabled() / initializeStorage() / closeStorage()
 */

const mode = process.env.WEBNESTDEV_STORAGE ?? (process.env.NODE_ENV === "production" ? "postgres" : "json");
const connectionString = process.env.DATABASE_URL;

let pool: Pool | null = null;
let initialization: Promise<void> | null = null;

/** Имя таблицы с префиксом */
export function getTable(name: string): string {
  const prefix = (process.env.PG_TABLE_PREFIX ?? "webnestdev").replace(/[^A-Za-z0-9_]/g, "_");
  return `${prefix}_${name}`;
}

/** Совместимость: isYdbEnabled() → postgres mode */
export function isYdbEnabled(): boolean {
  return mode === "postgres";
}

/**
 * Проверка до старта сервера. Неизвестное значение `WEBNESTDEV_STORAGE` (например старый
 * `ydb`) раньше лишь печаталось в лог: сервер продолжал работать и писал JSON-файлы, а
 * оператор считал, что данные в базе. Ошибка на старте лучше тихой подмены хранилища.
 */
export function assertStorageConfigured(configured: string = mode, connection: string | undefined = connectionString): void {
  if (configured !== "json" && configured !== "postgres") {
    throw new Error(`WEBNESTDEV_STORAGE="${configured}" is not a known backend: use "json" or "postgres"`);
  }
  if (configured === "postgres" && !connection) {
    throw new Error("DATABASE_URL is required when WEBNESTDEV_STORAGE=postgres");
  }
}

/**
 * Which backend is actually live, for the startup line. A wrong WEBNESTDEV_STORAGE —
 * the old `ydb` value, for example — used to fail silently: the server kept running and
 * wrote JSON files while the operator believed the data was in a database. The returned
 * text says so out loud instead.
 */
export function describeStorage(): string {
  if (mode === "postgres") return "storage: postgres";
  const dir = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
  const suffix = process.env.WEBNESTDEV_DATA_DIR ? "" : " (inside the working directory — set WEBNESTDEV_DATA_DIR so a redeploy keeps accounts and conversations)";
  if (mode === "json") return "storage: json files in " + dir + suffix;
  return "storage: WEBNESTDEV_STORAGE=" + mode + " is not a known backend (json | postgres) — using json files in " + dir + suffix;
}

// ─── Marker для безопасных идентификаторов ───────────────────────────────────

class Identifier {
  constructor(readonly value: string) {}
}

function safeIdentifier(name: string): Identifier {
  return new Identifier(name.replace(/"/g, '""'));
}

// ─── Типизация generic tagged-шаблона ────────────────────────────────────────

export interface YdbQueryTag {
  /**
   * Generic call signature: q<T>`SELECT ...` → Promise<[T]>
   * В рантайме T = Array<Row> (массив строк из QueryResult.rows).
   * `const [rows] = await q<T>\`...\`` → rows = T (массив строк).
   */
  <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<[T]>;
  identifier: (name: string) => Identifier;
  transaction: (opts: Record<string, unknown>, cb: (tx: YdbQueryTag) => Promise<void>) => Promise<void>;
}

// ─── Сборка параметризованного SQL ────────────────────────────────────────────

function buildSql(strings: TemplateStringsArray, values: unknown[]): { sql: string; params: unknown[] } {
  let sql = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Identifier) {
        sql += `"${v.value}"`;
      } else {
        params.push(values[i] === undefined ? null : values[i]);
        sql += `$${params.length}`;
      }
    }
  }
  // В YDB-коде пустая строка записывается как "" (две двойные кавычки).
  // В PostgreSQL "" — это пустой идентификатор (ошибка).
  // Конвертируем все "" → '' (пустая строка в PG).
  // Не затрагивает нормальные идентификаторы вида "tableName".
  const finalSql = sql.trim().replace(/""/g, "''");
  return { sql: finalSql, params };
}

// ─── Конвертация UPSERT (YDB) → INSERT ... ON CONFLICT (PostgreSQL) ─────────

/** PK по имени таблицы (без префикса) — бьётся с DDL выше */
const PK_BY_TABLE: Record<string, string[]> = {
  users: ["id"],
  phone_accounts: ["phone"],
  yandex_accounts: ["yandex_id"],
  sessions: ["id"],
  projects: ["id"],
  conversations: ["id"],
  conversation_messages: ["conversation_id", "created_at", "message_id"],
  providers: ["project_id"],
  user_settings: ["user_id"],
  user_profiles: ["user_id"],
  usage_events: ["user_id", "usage_date", "event_id"],
  usage_counters: ["user_id", "usage_date", "kind"],
  project_counters: ["user_id"],
  model_usage: ["user_id", "usage_date", "run_id"],
  oauth_states: ["state"],
  github_connections: ["user_id"],
  gitlab_connections: ["user_id"],
  repo_connections: ["user_id", "provider"],
  database_connections: ["user_id"],
  yandex_connections: ["user_id"],
  cloud_connections: ["user_id", "provider"],
  domain_connections: ["user_id", "provider"],
  service_connections: ["user_id", "service"],
  project_sizes: ["project_id"],
  user_storage: ["user_id"],
  phone_consents: ["consent_id"],
  project_secrets: ["project_id"],
  secret_audit: ["id"],
  billing_payments: ["inv_id"],
  billing_subscriptions: ["user_id"],
  billing_counters: ["id"],
};

/**
 * Сторы используют YDB-оператор `UPSERT INTO <t> (cols) VALUES (...)`.
 * PostgreSQL его не знает — превращаем в
 * `INSERT INTO <t> (cols) VALUES (...) ON CONFLICT (<pk>) DO UPDATE SET ...`.
 * Число $-параметров не меняется, порядок cols ↔ $N сохраняется.
 */
function upsertToInsert(sql: string): string {
  const t = sql.trim();
  if (!/^UPSERT\s+INTO/i.test(t)) return t;
  const m = t.match(/^UPSERT\s+INTO\s+"?([\w]+)"?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*$/i);
  if (!m) return t;

  const rawTable = m[1];
  const prefix = (process.env.PG_TABLE_PREFIX ?? "webnestdev").replace(/[^A-Za-z0-9_]/g, "_");
  const baseName = rawTable.startsWith(prefix + "_") ? rawTable.slice(prefix.length + 1) : rawTable;
  const pkCols = PK_BY_TABLE[baseName] ?? [];

  const cols = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  const vals = m[3].split(",").map((s) => s.trim());

  const conflict = `ON CONFLICT (${pkCols.map((c) => `"${c}"`).join(", ")})`;
  const updateCols = cols
    .map((c, i) => ({ c, v: vals[i] ?? "$0" }))
    .filter((o) => !pkCols.includes(o.c));

  let out = `INSERT INTO "${rawTable}" (${cols.join(", ")}) VALUES (${vals.join(", ")})`;
  if (updateCols.length > 0) {
    out += ` ${conflict} DO UPDATE SET ${updateCols.map((o) => `"${o.c}"=${o.v}`).join(", ")}`;
  } else {
    out += ` ${conflict} DO NOTHING`;
  }
  return out;
}

// ─── Создание tagged-объекта ─────────────────────────────────────────────────

type Executor = (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;

function createTaggedQuery(executor: Executor): YdbQueryTag {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { sql, params } = buildSql(strings, values);
    return executor(upsertToInsert(sql), params).then(result => [result.rows] as [unknown]);
  };
  tag.identifier = safeIdentifier;
  tag.transaction = async (_opts: Record<string, unknown>, cb: (tx: YdbQueryTag) => Promise<void>) => {
    if (!pool) throw new Error("PostgreSQL pool is not initialized");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const txExecutor: Executor = (sql, params) => client.query(sql, params);
      const tx = createTaggedQuery(txExecutor);
      await cb(tx);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  };
  return tag as unknown as YdbQueryTag;
}

/** Возвращает tagged-шаблон, привязанный к общему pool */
export function ydbQuery(): YdbQueryTag {
  if (!pool) throw new Error("PostgreSQL pool is not initialized");
  return createTaggedQuery((sql, params) => pool!.query(sql, params));
}

/**
 * Advisory-лок PostgreSQL на всё время обхода. Нужен там, где работу делает только одна
 * реплика: сверка размеров хранилища иначе запускалась бы на каждой и одновременно, а две
 * сверки одного каталога бессмысленно тратят диск и дают разные числа в ответе.
 *
 * Возвращает null, если лок уже занят другой репликой (или база не инициализирована) —
 * это не ошибка, а «работу уже делает кто-то другой». Лок висит на выделенном соединении и
 * снимается в finally, поэтому падение обхода не оставляет его навсегда.
 */
export async function withAdvisoryLock<T>(name: string, action: () => Promise<T>): Promise<T | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [name],
    );
    if (!result.rows[0]?.locked) return null;
    try {
      return await action();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [name]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

// ─── Инициализация ────────────────────────────────────────────────────────────

export async function initializeStorage(): Promise<void> {
  if (!isYdbEnabled()) return;
  if (initialization) return initialization;
  initialization = (async () => {
    if (!connectionString) {
      throw new Error("DATABASE_URL is required when WEBNESTDEV_STORAGE=postgres");
    }
    pool = new Pool({ connectionString, max: 10 });
    const test = await pool.query("SELECT 1");
    if (!test.rows.length) throw new Error("PostgreSQL connection failed");

    const tbl = (name: string) => `"${safeIdentifier(getTable(name)).value}"`;

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("users")} (
      id TEXT NOT NULL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("phone_accounts")} (
      phone TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("phone_accounts")}_user ON ${tbl("phone_accounts")} (user_id)`);

    // Yandex ID sign-in keeps an identity link, not an OAuth token: the token is used
    // once to read the profile and is never stored.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("yandex_accounts")} (
      yandex_id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      login TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("yandex_accounts")}_user ON ${tbl("yandex_accounts")} (user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("sessions")} (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT ''
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("sessions")}_user ON ${tbl("sessions")} (user_id)`);
    // Таблица, созданная до появления idle-таймаута, приходит без этой колонки: CREATE TABLE
    // IF NOT EXISTS её не добавит, а обновление отметки упадёт на живом сервере. Пустое
    // значение читается как «отметки ещё нет» — такая сессия получает полный idle-срок.
    await pool.query(`ALTER TABLE ${tbl("sessions")} ADD COLUMN IF NOT EXISTS last_seen_at TEXT NOT NULL DEFAULT ''`);

    // Администраторы платформы — отдельные аккаунты, не пользователи панели (см. admin/admin-store.ts).
    // Пароль — scrypt, TOTP-секрет — зашифрованный, коды восстановления — только хешами.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("admin_users")} (
      id TEXT NOT NULL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      totp_secret TEXT NOT NULL DEFAULT '',
      totp_enabled_at TEXT NOT NULL DEFAULT '',
      recovery_hashes TEXT NOT NULL DEFAULT '[]',
      last_totp_step TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    // Сессии админ-приложения: id — sha256 токена, поэтому копия базы не даёт войти.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("admin_sessions")} (
      id TEXT NOT NULL PRIMARY KEY,
      admin_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("admin_sessions")}_admin ON ${tbl("admin_sessions")} (admin_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("projects")} (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      github_json TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("projects")}_user ON ${tbl("projects")} (user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("conversations")} (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      plan_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("conversations")}_project ON ${tbl("conversations")} (project_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("conversation_messages")} (
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      message_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL DEFAULT '',
      reasoning TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (conversation_id, created_at, message_id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("conversation_messages")}_project ON ${tbl("conversation_messages")} (project_id, created_at)`);
    // Databases created before the plan and reasoning columns existed are upgraded here:
    // CREATE TABLE IF NOT EXISTS would leave them without the new columns.
    await pool.query(`ALTER TABLE ${tbl("conversations")} ADD COLUMN IF NOT EXISTS plan_json TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE ${tbl("conversation_messages")} ADD COLUMN IF NOT EXISTS reasoning TEXT NOT NULL DEFAULT ''`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("providers")} (
      project_id TEXT NOT NULL PRIMARY KEY,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      token TEXT NOT NULL DEFAULT ''
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("user_settings")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      language TEXT NOT NULL DEFAULT 'ru',
      compact_mode BOOLEAN NOT NULL DEFAULT false,
      email_notifications BOOLEAN NOT NULL DEFAULT true,
      product_updates BOOLEAN NOT NULL DEFAULT true
    )`);

    // Контакты из знакомства при входе: имя, почта для связи и согласия на письма.
    // Отдельная таблица, а не колонки user_settings: знакомство заполняется один раз
    // и его наличие — признак, что аккаунт уже оставил данные.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("user_profiles")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      newsletter BOOLEAN NOT NULL DEFAULT false,
      product_updates BOOLEAN NOT NULL DEFAULT false,
      completed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("usage_events")} (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, usage_date, event_id)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("usage_counters")} (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      kind TEXT NOT NULL,
      used BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, usage_date, kind)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("project_counters")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      project_count BIGINT NOT NULL DEFAULT 0
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("model_usage")} (
      user_id TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      estimated BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, usage_date, run_id)
    )`);
    // Аналитика админки (routes/admin-analytics.ts) фильтрует расход по дню и группирует его по
    // проекту. Без этих индексов обзор и список проектов превращаются в полный перебор при каждом
    // открытии вкладки, а PK покрывает только одного пользователя.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("model_usage")}_date ON ${tbl("model_usage")} (usage_date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("model_usage")}_project ON ${tbl("model_usage")} (project_id, usage_date)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("oauth_states")} (
      state TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("github_connections")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      github_login TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("gitlab_connections")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      gitlab_login TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT 'https://gitlab.com',
      created_at TEXT NOT NULL
    )`);

    // GitVerse и SourceCraft: один токен на пользователя и провайдера. expires_at и
    // refresh_token нужны OAuth-подключению GitVerse — его access token живёт час.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("repo_connections")} (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      login TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("database_connections")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      scheme TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      database_name TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      url TEXT NOT NULL,
      ssl BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("yandex_connections")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      secret TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      cloud_id TEXT NOT NULL,
      account TEXT NOT NULL,
      allow_writes BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("cloud_connections")} (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      secret TEXT NOT NULL,
      account TEXT NOT NULL,
      allow_writes BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    )`);
    // Таблицы, созданные до появления разрешения на изменения, дополняются здесь: CREATE TABLE
    // IF NOT EXISTS оставил бы их без колонки и запись подключения падала бы на живом сервере.
    await pool.query(`ALTER TABLE ${tbl("cloud_connections")} ADD COLUMN IF NOT EXISTS allow_writes BOOLEAN NOT NULL DEFAULT true`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("service_connections")} (
      user_id TEXT NOT NULL,
      service TEXT NOT NULL,
      secret TEXT NOT NULL,
      account TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, service)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("domain_connections")} (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      secret TEXT NOT NULL,
      account TEXT NOT NULL,
      allow_writes BOOLEAN NOT NULL DEFAULT true,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    )`);
    // Кабинет, подключённый до появления разрешения на изменения, приходит без колонки:
    // CREATE TABLE IF NOT EXISTS её не добавит, а запись соединения упадёт на живом сервере.
    await pool.query(`ALTER TABLE ${tbl("domain_connections")} ADD COLUMN IF NOT EXISTS allow_writes BOOLEAN NOT NULL DEFAULT true`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("project_sizes")} (
      project_id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      last_write_at TEXT
    )`);
    // Таблица, созданная до появления холодного яруса, приходит без этой колонки: CREATE TABLE
    // IF NOT EXISTS её не добавит. NULL допустим — читатели берут `last_write_at ?? updated_at`,
    // а первая же сверка заполняет поле, не сдвигая его вперёд.
    await pool.query(`ALTER TABLE ${tbl("project_sizes")} ADD COLUMN IF NOT EXISTS last_write_at TEXT`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("project_sizes")}_user ON ${tbl("project_sizes")} (user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("user_storage")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      used_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("phone_consents")} (
      consent_id TEXT NOT NULL PRIMARY KEY,
      phone TEXT NOT NULL,
      consent_version TEXT NOT NULL,
      purpose TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      ip_hash TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("phone_consents")}_phone ON ${tbl("phone_consents")} (phone, consented_at)`);

    // Каноническое хранилище секретов проекта: один зашифрованный payload на проект.
    // В рабочей области пользователя `.env.local` не лежит — он монтируется в предпросмотр
    // из временного файла и удаляется вместе с ним.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("project_secrets")} (
      project_id TEXT NOT NULL PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);

    // Журнал операций с секретами: только имена и метаданные, значения сюда не попадают.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("secret_audit")} (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      names_json TEXT NOT NULL DEFAULT '[]',
      file TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("secret_audit")}_project ON ${tbl("secret_audit")} (project_id, created_at)`);

    // Оплата: счёт с номером Робокассы, подтверждение по ResultURL и действующая подписка.
    // Номер счёта — целое, его же возвращает уведомление, поэтому PRIMARY KEY именно inv_id.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("billing_payments")} (
      inv_id BIGINT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      amount BIGINT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'initial',
      parent_inv_id BIGINT,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("billing_payments")}_user ON ${tbl("billing_payments")} (user_id, created_at)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("billing_subscriptions")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      renews_at TEXT NOT NULL,
      auto_renew BOOLEAN NOT NULL DEFAULT false,
      parent_inv_id BIGINT NOT NULL DEFAULT 0,
      renewal_attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);

    // Сквозной счётчик номеров счетов: номер должен быть целым и уникальным на весь магазин.
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("billing_counters")} (
      id TEXT NOT NULL PRIMARY KEY,
      value BIGINT NOT NULL DEFAULT 0
    )`);

    // Базы, созданные до появления счётчика попыток, дополняются здесь.
    await pool.query(`ALTER TABLE ${tbl("billing_subscriptions")} ADD COLUMN IF NOT EXISTS renewal_attempts INTEGER NOT NULL DEFAULT 0`);

    console.log("[pg] storage initialized: all tables ready");
  })().catch((error) => {
    initialization = null;
    pool = null;
    throw error;
  });
  return initialization;
}

export async function closeStorage(): Promise<void> {
  const current = pool;
  pool = null;
  initialization = null;
  await current?.end();
}
