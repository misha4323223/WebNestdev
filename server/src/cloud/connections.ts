import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";
import type { CloudProviderId } from "./providers.js";

/**
 * Подключённое облако пользователя. Ключ лежит только в зашифрованном виде — так же, как
 * ключи Yandex Cloud и GitHub; наружу (в браузер и модели) он не возвращается никогда.
 * Файловое хранилище — запасной путь для локальной разработки, как у остальных сторов.
 */
export type CloudConnection = {
  userId: string;
  provider: CloudProviderId;
  /** JSON с полями провайдера (token / keyId+secret / key). */
  secret: string;
  account: string;
  createdAt: string;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

function fileFor(userId: string) {
  return path.join(root, "cloud", userId + ".json");
}

type FileShape = Record<string, Omit<CloudConnection, "userId" | "provider">>;

async function readAllFiles(userId: string): Promise<FileShape> {
  try {
    return JSON.parse(await readFile(fileFor(userId), "utf8")) as FileShape;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeAllFiles(userId: string, value: FileShape) {
  const file = fileFor(userId);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* временного файла может уже не быть */ }
    throw error;
  }
}

function decode(record: Omit<CloudConnection, "userId" | "provider">) {
  return isEncryptedSecret(record.secret) ? decryptSecret(record.secret) : record.secret;
}

export async function saveCloudConnection(connection: CloudConnection) {
  const stored = { ...connection, secret: encryptSecret(connection.secret) };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("cloud_connections"))}
        (user_id,provider,secret,account,created_at,updated_at)
      VALUES (${stored.userId},${stored.provider},${stored.secret},${stored.account},${stored.createdAt},${stored.updatedAt})
    `;
    return;
  }
  const all = await readAllFiles(connection.userId);
  all[connection.provider] = { secret: stored.secret, account: stored.account, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  await writeAllFiles(connection.userId, all);
}

export async function listCloudConnections(userId: string): Promise<CloudConnection[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ provider: string; secret: string; account: string; created_at: string; updated_at: string }>>`
      SELECT provider,secret,account,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("cloud_connections"))}
      WHERE user_id = ${userId}
    `;
    return (rows ?? []).map(row => ({
      userId,
      provider: row.provider as CloudProviderId,
      secret: decode({ secret: row.secret, account: row.account, createdAt: row.created_at, updatedAt: row.updated_at }),
      account: row.account,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const all = await readAllFiles(userId);
  return Object.entries(all).map(([provider, record]) => ({
    userId,
    provider: provider as CloudProviderId,
    secret: decode(record),
    account: record.account,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

export async function getCloudConnection(userId: string, provider: CloudProviderId) {
  const all = await listCloudConnections(userId);
  return all.find(connection => connection.provider === provider) ?? null;
}

export async function deleteCloudConnection(userId: string, provider: CloudProviderId) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("cloud_connections"))} WHERE user_id = ${userId} AND provider = ${provider}`;
    return;
  }
  const all = await readAllFiles(userId);
  if (!(provider in all)) return;
  delete all[provider];
  await writeAllFiles(userId, all);
}
