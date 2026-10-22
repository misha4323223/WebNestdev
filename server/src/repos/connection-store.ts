import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

/**
 * Подключения к российским хостингам кода. Устроены как подключения GitHub и GitLab: один
 * токен на пользователя и провайдера, шифруется тем же ключом и никогда не возвращается в
 * браузер. `refreshToken` нужен только OAuth-подключению GitVerse: его access token живёт час.
 */
export type RepoProviderId = "gitverse" | "sourcecraft";

export type RepoConnection = {
  id: string;
  userId: string;
  provider: RepoProviderId;
  accessToken: string;
  refreshToken?: string;
  /** Когда истекает access token OAuth-подключения (GitVerse выдаёт час). */
  expiresAt?: string;
  login?: string;
  baseUrl: string;
  createdAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const storeName = () => getTable("repo_connections");

async function writeConnection(file: string, connection: RepoConnection) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(connection), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

export async function saveRepoConnection(input: {
  userId: string;
  provider: RepoProviderId;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  login?: string;
  baseUrl: string;
}) {
  const connection: RepoConnection = {
    id: randomUUID(),
    userId: input.userId,
    provider: input.provider,
    accessToken: encryptSecret(input.accessToken),
    ...(input.refreshToken ? { refreshToken: encryptSecret(input.refreshToken) } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    login: input.login,
    baseUrl: input.baseUrl,
    createdAt: new Date().toISOString(),
  };
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    await sql`
      UPSERT INTO ${sql.identifier(storeName())}
        (user_id,provider,id,access_token,refresh_token,expires_at,login,base_url,created_at)
      VALUES (${connection.userId},${connection.provider},${connection.id},${connection.accessToken},${connection.refreshToken ?? ""},${connection.expiresAt ?? ""},${connection.login ?? ""},${connection.baseUrl},${connection.createdAt})
    `;
    return;
  }
  await writeConnection(path.join(root, "repos", input.provider, input.userId + ".json"), connection);
}

export async function getRepoConnection(userId: string, provider: RepoProviderId): Promise<RepoConnection | null> {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const [rows] = await sql<Array<{ user_id: string; provider: string; id: string; access_token: string; refresh_token: string; expires_at: string; login: string; base_url: string; created_at: string }>>`
      SELECT user_id,provider,id,access_token,refresh_token,expires_at,login,base_url,created_at
      FROM ${sql.identifier(storeName())}
      WHERE user_id = ${userId} AND provider = ${provider}
      LIMIT 1
    `;
    const row = rows?.[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider as RepoProviderId,
      accessToken: decryptSecret(row.access_token),
      ...(row.refresh_token ? { refreshToken: decryptSecret(row.refresh_token) } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      login: row.login || undefined,
      baseUrl: row.base_url,
      createdAt: row.created_at,
    };
  }
  const file = path.join(root, "repos", provider, userId + ".json");
  try {
    const connection = JSON.parse(await readFile(file, "utf8")) as RepoConnection;
    return {
      ...connection,
      accessToken: isEncryptedSecret(connection.accessToken) ? decryptSecret(connection.accessToken) : connection.accessToken,
      ...(connection.refreshToken
        ? { refreshToken: isEncryptedSecret(connection.refreshToken) ? decryptSecret(connection.refreshToken) : connection.refreshToken }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteRepoConnection(userId: string, provider: RepoProviderId) {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    await sql`DELETE FROM ${sql.identifier(storeName())} WHERE user_id = ${userId} AND provider = ${provider}`;
    return;
  }
  try { await unlink(path.join(root, "repos", provider, userId + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
