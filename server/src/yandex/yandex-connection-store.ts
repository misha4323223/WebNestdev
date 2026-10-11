import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

/**
 * A linked Yandex Cloud account. `secret` is the credential the user pasted — a service
 * account authorized key (JSON), an IAM token, or a legacy OAuth token — always stored
 * encrypted. Writes are off until the user allows them in the card.
 */
export type YandexCredentialKind = "key" | "iam" | "oauth";
export type YandexConnection = {
  userId: string;
  id: string;
  kind: YandexCredentialKind;
  secret: string;
  folderId?: string;
  cloudId?: string;
  account?: string;
  allowWrites: boolean;
  createdAt: string;
  updatedAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

async function writeConnection(file: string, connection: YandexConnection) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(connection), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}

export async function saveYandexConnection(connection: Omit<YandexConnection, "secret"> & { secret: string }) {
  const stored: YandexConnection = { ...connection, secret: encryptSecret(connection.secret) };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("yandex_connections"))}
        (user_id,id,kind,secret,folder_id,cloud_id,account,allow_writes,created_at,updated_at)
      VALUES (${stored.userId},${stored.id},${stored.kind},${stored.secret},${stored.folderId ?? ""},${stored.cloudId ?? ""},${stored.account ?? ""},${stored.allowWrites},${stored.createdAt},${stored.updatedAt})
    `;
    return connection;
  }
  await writeConnection(path.join(root, "yandex", connection.userId + ".json"), stored);
  return connection;
}

export async function getYandexConnection(userId: string): Promise<YandexConnection | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{user_id:string;id:string;kind:string;secret:string;folder_id:string;cloud_id:string;account:string;allow_writes:boolean;created_at:string;updated_at:string}>>`
      SELECT user_id,id,kind,secret,folder_id,cloud_id,account,allow_writes,created_at,updated_at
      FROM ${ydbQuery().identifier(getTable("yandex_connections"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row = rows?.[0];
    if (!row) return null;
    const connection: YandexConnection = {
      userId: row.user_id,
      id: row.id,
      kind: row.kind as YandexCredentialKind,
      secret: row.secret,
      folderId: row.folder_id || undefined,
      cloudId: row.cloud_id || undefined,
      account: row.account || undefined,
      allowWrites: Boolean(row.allow_writes),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (!isEncryptedSecret(connection.secret)) {
      const plaintext = connection.secret;
      await saveYandexConnection({ ...connection, secret: plaintext });
      return { ...connection, secret: plaintext };
    }
    return { ...connection, secret: decryptSecret(connection.secret) };
  }
  const file = path.join(root, "yandex", userId + ".json");
  try {
    const connection = JSON.parse(await readFile(file, "utf8")) as YandexConnection;
    if (!isEncryptedSecret(connection.secret)) {
      const plaintext = connection.secret;
      await writeConnection(file, { ...connection, secret: encryptSecret(plaintext) });
      return { ...connection, secret: plaintext };
    }
    return { ...connection, secret: decryptSecret(connection.secret) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteYandexConnection(userId: string) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("yandex_connections"))} WHERE user_id = ${userId}`;
    return;
  }
  try { await unlink(path.join(root, "yandex", userId + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
