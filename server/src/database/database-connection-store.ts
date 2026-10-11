import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

/**
 * Where the user's own database lives. The list is deliberately Russian-first: these
 * are the providers the product recommends, and every one of them issues a normal
 * PostgreSQL/MySQL/MongoDB connection string. "custom" covers a server of the user's own.
 */
export type DatabaseProvider = "yandex-postgresql" | "yandex-ydb" | "vk-cloud" | "selectel" | "timeweb" | "cloud-ru" | "custom";

export const DATABASE_PROVIDERS: DatabaseProvider[] = ["yandex-postgresql", "yandex-ydb", "vk-cloud", "selectel", "timeweb", "cloud-ru", "custom"];

export function isDatabaseProvider(value: unknown): value is DatabaseProvider {
  return typeof value === "string" && (DATABASE_PROVIDERS as string[]).includes(value);
}

/**
 * A linked database of the user's own. Both the password and the whole connection
 * string count as secrets: they are stored encrypted and are never returned to the
 * browser or to the model in clear text.
 */
export type DatabaseConnection = {
  userId: string;
  id: string;
  provider: DatabaseProvider;
  scheme: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  url: string;
  ssl: boolean;
  createdAt: string;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

async function writeConnection(file: string, connection: DatabaseConnection) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(connection), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}

/** The credential fields are encrypted before they reach the file or the table. */
function sealed(connection: DatabaseConnection) {
  return { ...connection, password: encryptSecret(connection.password), url: encryptSecret(connection.url) };
}

export async function saveDatabaseConnection(connection: DatabaseConnection) {
  const stored = sealed(connection);
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("database_connections"))}
        (user_id,id,provider,scheme,host,port,database_name,username,password,url,ssl,created_at,updated_at)
      VALUES (${stored.userId},${stored.id},${stored.provider},${stored.scheme},${stored.host},${stored.port},${stored.database},${stored.username},${stored.password},${stored.url},${stored.ssl},${stored.createdAt},${stored.updatedAt})
    `;
    return connection;
  }
  await writeConnection(path.join(root, "database", connection.userId + ".json"), stored);
  return connection;
}

export async function getDatabaseConnection(userId: string): Promise<DatabaseConnection | null> {
  const open = (connection: DatabaseConnection): DatabaseConnection => ({
    ...connection,
    password: decryptSecret(connection.password),
    url: decryptSecret(connection.url),
  });

  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ user_id: string; id: string; provider: string; scheme: string; host: string; port: number; database_name: string; username: string; password: string; url: string; ssl: boolean; created_at: string; updated_at: string }>>`
      SELECT user_id,id,provider,scheme,host,port,database_name,username,password,url,ssl,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("database_connections"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row = rows?.[0];
    if (!row) return null;
    const connection: DatabaseConnection = {
      userId: row.user_id,
      id: row.id,
      provider: isDatabaseProvider(row.provider) ? row.provider : "custom",
      scheme: row.scheme,
      host: row.host,
      port: Number(row.port) || 0,
      database: row.database_name,
      username: row.username,
      password: row.password,
      url: row.url,
      ssl: Boolean(row.ssl),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (!isEncryptedSecret(connection.password) || !isEncryptedSecret(connection.url)) {
      await saveDatabaseConnection(open(connection));
    }
    return open(connection);
  }

  const file = path.join(root, "database", userId + ".json");
  try {
    const connection = JSON.parse(await readFile(file, "utf8")) as DatabaseConnection;
    if (!isEncryptedSecret(connection.password) || !isEncryptedSecret(connection.url)) {
      await writeConnection(file, sealed(open(connection)));
    }
    return open(connection);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteDatabaseConnection(userId: string) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("database_connections"))} WHERE user_id = ${userId}`;
    return;
  }
  try { await unlink(path.join(root, "database", userId + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
