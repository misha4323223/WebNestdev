import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

/**
 * Подключённый сервис пользователя: ключи хранилища, почты, оплаты, AI, карт или CRM. Значения
 * лежат только в зашифрованном виде — так же, как ключи облаков и регистраторов; наружу, в браузер
 * и модели, они не возвращаются. Файловое хранилище — запасной путь для локальной разработки.
 */
export type ServiceConnection = {
  userId: string;
  service: string;
  /** JSON с полями сервиса (ключи, адреса кабинетов). */
  secret: string;
  account: string;
  createdAt: string;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

function fileFor(userId: string) {
  return path.join(root, "services", userId + ".json");
}

type FileShape = Record<string, Omit<ServiceConnection, "userId" | "service">>;

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

function decode(record: Omit<ServiceConnection, "userId" | "service">) {
  return isEncryptedSecret(record.secret) ? decryptSecret(record.secret) : record.secret;
}

export async function saveServiceConnection(connection: ServiceConnection) {
  const stored = { ...connection, secret: encryptSecret(connection.secret) };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("service_connections"))}
        (user_id,service,secret,account,created_at,updated_at)
      VALUES (${stored.userId},${stored.service},${stored.secret},${stored.account},${stored.createdAt},${stored.updatedAt})
    `;
    return;
  }
  const all = await readAllFiles(connection.userId);
  all[connection.service] = { secret: stored.secret, account: stored.account, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  await writeAllFiles(connection.userId, all);
}

export async function listServiceConnections(userId: string): Promise<ServiceConnection[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ service: string; secret: string; account: string; created_at: string; updated_at: string }>>`
      SELECT service,secret,account,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("service_connections"))}
      WHERE user_id = ${userId}
    `;
    return (rows ?? []).map(row => ({
      userId,
      service: row.service,
      secret: decode({ secret: row.secret, account: row.account, createdAt: row.created_at, updatedAt: row.updated_at }),
      account: row.account,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  const all = await readAllFiles(userId);
  return Object.entries(all).map(([service, record]) => ({
    userId,
    service,
    secret: decode(record),
    account: record.account,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

export async function getServiceConnection(userId: string, service: string) {
  const all = await listServiceConnections(userId);
  return all.find(connection => connection.service === service) ?? null;
}

export async function deleteServiceConnection(userId: string, service: string) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("service_connections"))} WHERE user_id = ${userId} AND service = ${service}`;
    return;
  }
  const all = await readAllFiles(userId);
  if (!(service in all)) return;
  delete all[service];
  await writeAllFiles(userId, all);
}
