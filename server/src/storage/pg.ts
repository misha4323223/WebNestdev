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
  sessions: ["id"],
  projects: ["id"],
  conversations: ["id"],
  conversation_messages: ["conversation_id", "created_at", "message_id"],
  providers: ["project_id"],
  user_settings: ["user_id"],
  subscriptions: ["user_id"],
  usage_events: ["user_id", "usage_date", "event_id"],
  usage_counters: ["user_id", "usage_date", "kind"],
  project_counters: ["user_id"],
  model_usage: ["user_id", "usage_date", "run_id"],
  oauth_states: ["state"],
  github_connections: ["user_id"],
  database_connections: ["user_id"],
  yandex_connections: ["user_id"],
  project_sizes: ["project_id"],
  user_storage: ["user_id"],
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

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("sessions")} (
      id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("sessions")}_user ON ${tbl("sessions")} (user_id)`);

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
      tool_call_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (conversation_id, created_at, message_id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${getTable("conversation_messages")}_project ON ${tbl("conversation_messages")} (project_id, created_at)`);

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

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("subscriptions")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
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

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("project_sizes")} (
      project_id TEXT NOT NULL PRIMARY KEY,
      user_id TEXT NOT NULL,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_${tbl("project_sizes")}_user ON ${tbl("project_sizes")} (user_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ${tbl("user_storage")} (
      user_id TEXT NOT NULL PRIMARY KEY,
      used_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )`);

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
