import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";
import type { DomainRegistrarId } from "./providers.js";

/**
 * Подключённый кабинет регистратора. Пароль или токен лежит только в зашифрованном виде —
 * так же, как ключи облаков; наружу он не возвращается никогда. Файловое хранилище —
 * запасной путь для локальной разработки, как у остальных сторов.
 *
 * `allowWrites` — решение пользователя, а не догадка платформы: пароль кабинета открывает и
 * DNS, поэтому карточка спрашивает об этом до сохранения ключа, разрешение включено по
 * умолчанию и выключается тем же переключателем, что у облаков.
 */
export type DomainConnection = {
  userId: string;
  provider: DomainRegistrarId;
  /** JSON с полями регистратора (username+password / login+passwd / token). */
  secret: string;
  account: string;
  /** Разрешены ли агенту изменения в кабинете: DNS-записи и настройки зоны. */
  allowWrites: boolean;
  createdAt: string;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

function fileFor(userId: string) {
  return path.join(root, "domains", userId + ".json");
}

type FileShape = Record<string, Omit<DomainConnection, "userId" | "provider">>;

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

export async function saveDomainConnection(connection: DomainConnection) {
  const stored = { ...connection, secret: encryptSecret(connection.secret) };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("domain_connections"))}
        (user_id,provider,secret,account,allow_writes,created_at,updated_at)
      VALUES (${stored.userId},${stored.provider},${stored.secret},${stored.account},${stored.allowWrites},${stored.createdAt},${stored.updatedAt})
    `;
    return;
  }
  const all = await readAllFiles(connection.userId);
  all[connection.provider] = { secret: stored.secret, account: stored.account, allowWrites: stored.allowWrites, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  await writeAllFiles(connection.userId, all);
}

export async function listDomainConnections(userId: string): Promise<DomainConnection[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ provider: string; secret: string; account: string; allow_writes: boolean; created_at: string; updated_at: string }>>`
      SELECT provider,secret,account,allow_writes,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("domain_connections"))}
      WHERE user_id = ${userId}
    `;
    return (rows ?? []).map(row => ({
      userId,
      provider: row.provider as DomainRegistrarId,
      secret: decode(row.secret),
      account: row.account,
      // Строка, созданная до появления колонки, читается как «изменения разрешены»: именно так
      // ведёт себя новая карточка, и поведение не меняется молча в другую сторону.
      allowWrites: row.allow_writes === undefined || row.allow_writes === null ? true : Boolean(row.allow_writes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const all = await readAllFiles(userId);
  return Object.entries(all).map(([provider, record]) => ({
    userId,
    provider: provider as DomainRegistrarId,
    secret: decode(record.secret),
    account: record.account,
    allowWrites: record.allowWrites ?? true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

export async function getDomainConnection(userId: string, provider: DomainRegistrarId) {
  const all = await listDomainConnections(userId);
  return all.find(connection => connection.provider === provider) ?? null;
}

export async function deleteDomainConnection(userId: string, provider: DomainRegistrarId) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("domain_connections"))} WHERE user_id = ${userId} AND provider = ${provider}`;
    return;
  }
  const all = await readAllFiles(userId);
  if (!(provider in all)) return;
  delete all[provider];
  await writeAllFiles(userId, all);
}
