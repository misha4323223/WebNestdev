import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type GitHubConnection = {
  id: string;
  accessToken: string;
  githubLogin?: string;
  createdAt: string;
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");

export async function saveGitHubConnection(accessToken: string, githubLogin?: string) {
  const connection: GitHubConnection = {
    id: randomUUID(),
    accessToken,
    githubLogin,
    createdAt: new Date().toISOString(),
  };
  const dir = path.join(root, "github");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "connection.json"), JSON.stringify(connection), { mode: 0o600 });
  return { id: connection.id, githubLogin: connection.githubLogin, createdAt: connection.createdAt };
}

export async function getGitHubConnection(): Promise<GitHubConnection | null> {
  try {
    return JSON.parse(await readFile(path.join(root, "github", "connection.json"), "utf8")) as GitHubConnection;
  } catch {
    return null;
  }
}

export async function deleteGitHubConnection() {
  try {
    await writeFile(path.join(root, "github", "connection.json"), "", { mode: 0o600 });
  } catch {}
}
