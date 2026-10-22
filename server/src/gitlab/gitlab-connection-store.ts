import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";

export type GitLabConnection = {
  id: string;
  userId: string;
  accessToken: string;
  gitlabLogin?: string;
  /** Адрес инсталляции: gitlab.com или свой GitLab. Токен действителен только на нём. */
  baseUrl: string;
  createdAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

async function writeConnection(file: string, connection: GitLabConnection) {
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

export async function saveGitLabConnection(userId: string, accessToken: string, gitlabLogin: string | undefined, baseUrl: string) {
  const connection: GitLabConnection = {
    id: randomUUID(),
    userId,
    accessToken: encryptSecret(accessToken),
    gitlabLogin,
    baseUrl,
    createdAt: new Date().toISOString(),
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("gitlab_connections"))}
        (user_id,id,access_token,gitlab_login,base_url,created_at)
      VALUES (${connection.userId},${connection.id},${connection.accessToken},${connection.gitlabLogin ?? ""},${connection.baseUrl},${connection.createdAt})
    `;
    return { id: connection.id, gitlabLogin: connection.gitlabLogin, baseUrl: connection.baseUrl, createdAt: connection.createdAt };
  }
  await writeConnection(path.join(root, "gitlab", userId + ".json"), connection);
  return { id: connection.id, gitlabLogin: connection.gitlabLogin, baseUrl: connection.baseUrl, createdAt: connection.createdAt };
}

export async function getGitLabConnection(userId: string): Promise<GitLabConnection | null> {
  if (isYdbEnabled()) {
    const sql = ydbQuery();
    const [rows] = await sql<Array<{ user_id: string; id: string; access_token: string; gitlab_login: string; base_url: string; created_at: string }>>`
      SELECT user_id,id,access_token,gitlab_login,base_url,created_at
      FROM ${ydbQuery().identifier(getTable("gitlab_connections"))}
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    const row = rows?.[0];
    if (!row) return null;
    let token = row.access_token;
    if (!isEncryptedSecret(token)) {
      const plaintext = token;
      token = encryptSecret(token);
      await ydbQuery()`
        UPSERT INTO ${ydbQuery().identifier(getTable("gitlab_connections"))}
          (user_id,id,access_token,gitlab_login,base_url,created_at)
        VALUES (${row.user_id},${row.id},${token},${row.gitlab_login},${row.base_url},${row.created_at})
      `;
      token = plaintext;
    } else token = decryptSecret(token);
    return { id: row.id, userId: row.user_id, accessToken: token, gitlabLogin: row.gitlab_login || undefined, baseUrl: row.base_url, createdAt: row.created_at };
  }
  const file = path.join(root, "gitlab", userId + ".json");
  try {
    const connection = JSON.parse(await readFile(file, "utf8")) as GitLabConnection;
    if (!isEncryptedSecret(connection.accessToken)) {
      const plaintext = connection.accessToken;
      await writeConnection(file, { ...connection, accessToken: encryptSecret(plaintext) });
      return { ...connection, accessToken: plaintext };
    }
    return { ...connection, accessToken: decryptSecret(connection.accessToken) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteGitLabConnection(userId: string) {
  if (isYdbEnabled()) {
    await ydbQuery()`DELETE FROM ${ydbQuery().identifier(getTable("gitlab_connections"))} WHERE user_id = ${userId}`;
    return;
  }
  try { await unlink(path.join(root, "gitlab", userId + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
