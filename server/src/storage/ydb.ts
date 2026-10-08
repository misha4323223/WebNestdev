import { Driver } from "@ydbjs/core";
import { query } from "@ydbjs/query";
import { EnvironCredentialsProvider } from "@ydbjs/auth/environ";
import { AccessTokenCredentialsProvider } from "@ydbjs/auth/access-token";

const mode = process.env.WEBNESTDEV_STORAGE ?? (process.env.NODE_ENV === "production" ? "ydb" : "json");
const connectionString = process.env.YDB_CONNECTION_STRING;

let driver: Driver | null = null;
let sql: ReturnType<typeof query> | null = null;
let initialization: Promise<void> | null = null;

export function isYdbEnabled() {
  return mode === "ydb";
}

function getTable(name: string) {
  const prefix = (process.env.YDB_TABLE_PREFIX ?? "webnestdev").replace(/[^A-Za-z0-9_]/g, "_");
  return \`\${prefix}_\${name}\`;
}

export function ydbQuery() {
  if (!sql) throw new Error("YDB is not initialized");
  return sql;
}

export async function initializeStorage() {
  if (!isYdbEnabled()) return;
  if (initialization) return initialization;
  initialization = (async () => {
    if (!connectionString) {
      throw new Error("YDB_CONNECTION_STRING is required when WEBNESTDEV_STORAGE=ydb");
    }
    driver = new Driver(connectionString, {
      credentialsProvider: process.env.YDB_TOKEN
        ? new AccessTokenCredentialsProvider({ token: process.env.YDB_TOKEN })
        : new EnvironCredentialsProvider(connectionString),
    });
    await driver.ready();
    sql = query(driver);

    const q = sql;
    await q.\`CREATE TABLE IF NOT EXISTS \${q.identifier(getTable("users"))} (
      id Utf8 NOT NULL,
      email Utf8 NOT NULL,
      password_hash Utf8 NOT NULL,
      created_at Utf8 NOT NULL,
      PRIMARY KEY (id),
      INDEX email_idx GLOBAL UNIQUE ON (email)
    )\`;
    await q.\`CREATE TABLE IF NOT EXISTS \${q.identifier(getTable("sessions"))} (
      id Utf8 NOT NULL,
      user_id Utf8 NOT NULL,
      expires_at Utf8 NOT NULL,
      PRIMARY KEY (id),
      INDEX user_idx GLOBAL ON (user_id)
    )\`;
    await q.\`CREATE TABLE IF NOT EXISTS \${q.identifier(getTable("projects"))} (
      id Utf8 NOT NULL,
      name Utf8 NOT NULL,
      created_at Utf8 NOT NULL,
      updated_at Utf8 NOT NULL,
      github_json Utf8 NOT NULL,
      user_id Utf8 NOT NULL,
      PRIMARY KEY (id),
      INDEX user_idx GLOBAL ON (user_id)
    )\`;
    await q.\`CREATE TABLE IF NOT EXISTS \${q.identifier(getTable("conversations"))} (
      id Utf8 NOT NULL,
      project_id Utf8 NOT NULL,
      title Utf8 NOT NULL,
      messages_json Utf8 NOT NULL,
      created_at Utf8 NOT NULL,
      updated_at Utf8 NOT NULL,
      PRIMARY KEY (id),
      INDEX project_idx GLOBAL ON (project_id)
    )\`;
    await q.\`CREATE TABLE IF NOT EXISTS \${q.identifier(getTable("providers"))} (
      project_id Utf8 NOT NULL,
      provider Utf8 NOT NULL,
      base_url Utf8 NOT NULL,
      model Utf8 NOT NULL,
      token Utf8 NOT NULL,
      PRIMARY KEY (project_id)
    )\`;
    await q.\`CREATE TABLE IF NOT EXISTS \${q.identifier(getTable("github_connections"))} (
      user_id Utf8 NOT NULL,
      id Utf8 NOT NULL,
      access_token Utf8 NOT NULL,
      github_login Utf8 NOT NULL,
      created_at Utf8 NOT NULL,
      PRIMARY KEY (user_id)
    )\`;
  })().catch(error => {
    initialization = null;
    sql = null;
    driver = null;
    throw error;
  });
  return initialization;
}

export async function closeStorage() {
  const current = driver;
  driver = null;
  sql = null;
  initialization = null;
  await current?.close();
}

export { getTable };
