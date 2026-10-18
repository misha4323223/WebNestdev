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
 *
 * `allowWrites` — решение пользователя, а не догадка платформы: ключ облака почти всегда
 * открывает и чтение, и изменение ресурсов, поэтому при подключении карточка прямо говорит об
 * этом, разрешение включено по умолчанию и выключается переключателем в той же карточке.
 */
export type CloudConnection = {
  userId: string;
  provider: CloudProviderId;
  /** JSON с полями провайдера (token / keyId+secret / key). */
  secret: string;
  account: string;
  /** Разрешены ли агенту создание, изменение и удаление ресурсов этого облака. */
  allowWrites: boolean;
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

function decode(secret: string) {
  return isEncryptedSecret(secret) ? decryptSecret(secret) : secret;
}

export async function saveCloudConnection(connection: CloudConnection) {
  const stored = { ...connection, secret: encryptSecret(connection.secret) };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("cloud_connections"))}
        (user_id,provider,secret,account,allow_writes,created_at,updated_at)
      VALUES (${stored.userId},${stored.provider},${stored.secret},${stored.account},${stored.allowWrites},${stored.createdAt},${stored.updatedAt})
    `;
    return;
  }
  const all = await readAllFiles(connection.userId);
  all[connection.provider] = { secret: stored.secret, account: stored.account, allowWrites: stored.allowWrites, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  await writeAllFiles(connection.userId, all);
}

export async function listCloudConnections(userId: string): Promise<CloudConnection[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ provider: string; secret: string; account: string; allow_writes: boolean; created_at: string; updated_at: string }>>`
      SELECT provider,secret,account,allow_writes,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("cloud_connections"))}
      WHERE user_id = ${userId}
    `;
    return (rows ?? []).map(row => ({
      userId,
      provider: row.provider as CloudProviderId,
      secret: decode(row.secret),
      account: row.account,
      // Строка, созданная до появления колонки, читается как «изменения разрешены»: именно так
      // ведёт себя новая карточка, а значит поведение не меняется молча в другую сторону.
      allowWrites: row.allow_writes === undefined || row.allow_writes === null ? true : Boolean(row.allow_writes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const all = await readAllFiles(userId);
  return Object.entries(all).map(([provider, record]) => ({
    userId,
    provider: provider as CloudProviderId,
    secret: decode(record.secret),
    account: record.account,
    allowWrites: record.allowWrites ?? true,
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
