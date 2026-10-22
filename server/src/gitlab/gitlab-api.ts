import { getGitLabConnection } from "./gitlab-connection-store.js";
import { getPlatformEnv } from "../platform/platform-env.js";

const DEFAULT_BASE = "https://gitlab.com";

/** Адрес GitLab: gitlab.com по умолчанию, свой сервер — через `GITLAB_BASE_URL`. */
export function gitlabBaseUrl() {
  const configured = getPlatformEnv("GITLAB_BASE_URL")?.trim() || process.env.GITLAB_BASE_URL?.trim();
  return (configured || DEFAULT_BASE).replace(/\/+$/, "");
}

export type GitLabProject = {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  default_branch: string;
  web_url: string;
  http_url_to_repo?: string;
  visibility?: string;
  namespace?: { full_path?: string };
  statistics?: { repository_size?: number };
};

function apiBase(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "") + "/api/v4";
}

function authHeaders(token: string) {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Authorization", "Bearer " + token);
  return headers;
}

async function gitlabFetchWithToken<T>(baseUrl: string, token: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders(token);
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  const response = await fetch(apiBase(baseUrl) + pathname, { ...init, headers });
  const body = await response.text();
  if (!response.ok) throw new Error("GitLab API вернул " + response.status + ": " + body.slice(0, 1000));
  return body ? JSON.parse(body) as T : null as T;
}

async function gitlabFetch<T>(userId: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const connection = await getGitLabConnection(userId);
  if (!connection) throw new Error("GitLab не подключён");
  return gitlabFetchWithToken<T>(connection.baseUrl || gitlabBaseUrl(), connection.accessToken, pathname, init);
}

/**
 * Проверка личного токена до сохранения: GitLab отвечает владельцем токена или отказом. Так
 * подключение даёт понятную ошибку сразу, а не «пустой список репозиториев» потом.
 */
export async function getGitLabLoginFromToken(token: string, baseUrl = gitlabBaseUrl()) {
  let response: Response;
  try {
    response = await fetch(apiBase(baseUrl) + "/user", { headers: authHeaders(token) });
  } catch (error) {
    throw new Error("Не удалось связаться с GitLab: " + (error instanceof Error ? error.message : String(error)));
  }
  const body = await response.text();
  if (response.status === 401) throw new Error("GitLab не принял токен: проверьте, что он скопирован целиком, не истёк и выдан для этого GitLab");
  if (!response.ok) throw new Error("GitLab API вернул " + response.status + ": " + body.slice(0, 300));
  const user = JSON.parse(body) as { username?: string };
  if (!user.username) throw new Error("GitLab не вернул имя пользователя для этого токена");
  return user.username;
}

export async function getGitLabUser(userId: string) {
  return gitlabFetch<{ id: number; username: string; name?: string }>(userId, "/user");
}

export async function listGitLabRepositories(userId: string) {
  return gitlabFetch<GitLabProject[]>(
    userId,
    "/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at",
  );
}

/** Размер репозитория нужен до импорта: на бесплатном тарифе больше 100 МБ не принимается. */
export async function getGitLabProject(userId: string, projectId: number) {
  return gitlabFetch<GitLabProject>(userId, "/projects/" + projectId + "?statistics=true");
}

type TreeEntry = { id: string; name: string; type: "blob" | "tree"; path: string; mode: string };

/**
 * Дерево репозитория постранично: GitLab отдаёт максимум 100 записей и не возвращает всё
 * рекурсивно, если проект большой. Предел страниц защищает от бесконечного `x-next-page`.
 */
export async function getGitLabTree(userId: string, projectId: number, branch: string) {
  const entries: TreeEntry[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await gitlabFetchWithPage<TreeEntry[]>(
      userId,
      "/projects/" + projectId + "/repository/tree?recursive=true&per_page=100&page=" + page + "&ref=" + encodeURIComponent(branch),
    );
    entries.push(...result.data);
    if (!result.nextPage) break;
  }
  return entries;
}

async function gitlabFetchWithPage<T>(userId: string, pathname: string): Promise<{ data: T; nextPage: boolean }> {
  const connection = await getGitLabConnection(userId);
  if (!connection) throw new Error("GitLab не подключён");
  const response = await fetch(apiBase(connection.baseUrl || gitlabBaseUrl()) + pathname, { headers: authHeaders(connection.accessToken) });
  const body = await response.text();
  if (!response.ok) throw new Error("GitLab API вернул " + response.status + ": " + body.slice(0, 1000));
  const nextPage = response.headers.get("x-next-page")?.trim() ?? "";
  return { data: (body ? JSON.parse(body) : []) as T, nextPage: Boolean(nextPage && nextPage !== "0") };
}

/** Содержимое файла. GitLab отдаёт raw-байты, поэтому base64-декодирование не нужно. */
export async function getGitLabFile(userId: string, projectId: number, filePath: string, branch: string) {
  const connection = await getGitLabConnection(userId);
  if (!connection) throw new Error("GitLab не подключён");
  const response = await fetch(
    apiBase(connection.baseUrl || gitlabBaseUrl()) + "/projects/" + projectId + "/repository/files/" + encodeURIComponent(filePath) + "/raw?ref=" + encodeURIComponent(branch),
    { headers: authHeaders(connection.accessToken) },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error("GitLab API вернул " + response.status + ": " + body.slice(0, 1000));
  }
  return Buffer.from(await response.arrayBuffer());
}
