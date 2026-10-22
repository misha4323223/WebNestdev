import path from "node:path";
import { writeFileInside } from "../sandbox/path-guard.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import type { RepoProvider, RepoSummary } from "./types.js";

const DEFAULT_API = "https://api.gitverse.ru";
const WEB = "https://gitverse.ru";

/** `GITVERSE_API_BASE` переопределяют только тесты: проверка токена не должна ходить в сеть. */
function apiBase() {
  return (getPlatformEnv("GITVERSE_API_BASE") ?? process.env.GITVERSE_API_BASE ?? DEFAULT_API).replace(/\/+$/, "");
}

function headers(token: string) {
  const value = new Headers();
  value.set("Accept", "application/vnd.gitverse.object+json;version=1");
  value.set("Authorization", "Bearer " + token);
  return value;
}

async function request(token: string, pathname: string, init: RequestInit = {}) {
  const merged = headers(token);
  for (const [key, value] of new Headers(init.headers)) merged.set(key, value);
  const response = await fetch(apiBase() + pathname, { ...init, headers: merged });
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 401) throw new Error("GitVerse не принял токен: проверьте, что он скопирован целиком и не истёк");
    throw new Error("GitVerse API вернул " + response.status + ": " + body.slice(0, 500));
  }
  return body ? JSON.parse(body) as unknown : null;
}

type RawRepository = {
  id?: number | string;
  name?: string;
  full_name?: string;
  default_branch?: string;
  html_url?: string;
  clone_url?: string;
  private?: boolean;
  owner?: { login?: string; username?: string };
};

function toSummary(raw: RawRepository): RepoSummary {
  const fullName = raw.full_name ?? "";
  const [ownerFromName, nameFromName] = fullName.split("/");
  const owner = raw.owner?.login ?? raw.owner?.username ?? ownerFromName ?? "";
  const name = raw.name ?? nameFromName ?? "";
  const web = raw.html_url ?? (owner && name ? WEB + "/" + owner + "/" + name : "");
  return {
    id: fullName || String(raw.id ?? ""),
    owner,
    name,
    fullName: fullName || (owner && name ? owner + "/" + name : name),
    defaultBranch: raw.default_branch?.trim() || "main",
    url: web,
    cloneUrl: raw.clone_url ?? (web ? web.replace(/\/+$/, "") + ".git" : ""),
    isPrivate: Boolean(raw.private),
  };
}

/**
 * Импорт через содержимое репозитория: `/contents` отдаёт каталог списком, а файл — base64.
 * Обход рекурсивный, потому что дерево одним запросом GitVerse документирует не полностью.
 */
async function importFiles(token: string, repository: RepoSummary, root: string) {
  const [owner, name] = splitFullName(repository);
  const branch = repository.defaultBranch || "main";
  const files: Array<{ path: string; content: string }> = [];
  const queue: string[] = [""];
  while (queue.length) {
    const dir = queue.shift() as string;
    const endpoint = "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name)
      + "/contents/" + encodePath(dir) + "?ref=" + encodeURIComponent(branch);
    const data = await request(token, endpoint);
    if (!data) continue;
    if (Array.isArray(data)) {
      for (const entry of data as Array<{ type?: string; path?: string }>) {
        if (!entry.path) continue;
        if (entry.type === "dir") queue.push(entry.path);
        else if (entry.type === "file") {
          if (files.length >= 5000) throw new Error("В репозитории слишком много файлов для импорта");
          const file = await request(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name)
            + "/contents/" + encodePath(entry.path) + "?ref=" + encodeURIComponent(branch)) as { content?: string; encoding?: string };
          if (file?.encoding === "base64" && file.content) files.push({ path: entry.path, content: file.content });
        }
      }
      continue;
    }
    const file = data as { path?: string; content?: string; encoding?: string };
    if (file.path && file.encoding === "base64" && file.content) files.push({ path: file.path, content: file.content });
  }
  let written = 0;
  for (const file of files) {
    // Путь пришёл из API: `..` и ссылки отсекает та же запись, что и у файлов агента.
    await writeFileInside(root, path.join(root, file.path), Buffer.from(file.content.replace(/\n/g, ""), "base64"));
    written++;
  }
  return written;
}

function splitFullName(repository: RepoSummary): [string, string] {
  if (repository.owner && repository.name) return [repository.owner, repository.name];
  const [owner, name] = repository.fullName.split("/");
  return [owner ?? "", name ?? repository.fullName];
}

function encodePath(value: string) {
  return value.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * Настройки OAuth читаются при каждом обращении: ключи можно вписать в панели «Ключи сервера»,
 * и вход должен заработать сразу, без перезапуска. Значения на момент импорта модуля были бы
 * пустыми — `loadPlatformEnv()` выполняется позже.
 */
function oauthSettings() {
  return {
    clientId: (getPlatformEnv("GITVERSE_CLIENT_ID") ?? process.env.GITVERSE_CLIENT_ID)?.trim() || undefined,
    clientSecret: (getPlatformEnv("GITVERSE_CLIENT_SECRET") ?? process.env.GITVERSE_CLIENT_SECRET)?.trim() || undefined,
    authorizeUrl: WEB + "/signin/oauth/authorize",
    tokenUrl: WEB + "/login/oauth/access_token",
    // read:user — профиль, read:repository — список и импорт, write:repository — отправка коммитов.
    scope: "read:user read:repository write:repository",
  };
}

export const gitverse: RepoProvider = {
  id: "gitverse",
  name: "GitVerse",
  apiBase: apiBase(),
  webBase: WEB,
  gitUsername: "oauth2",
  tokenUrl: WEB + "/user/settings/tokens",
  get oauth() { return oauthSettings(); },
  async loginFromToken(token) {
    const user = await request(token, "/user") as { login?: string; username?: string };
    const login = user?.login ?? user?.username;
    if (!login) throw new Error("GitVerse не вернул имя пользователя для этого токена");
    return login;
  },
  async listRepositories(token) {
    const data = await request(token, "/user/repos?per_page=100&sort=updated") as RawRepository[] | { repositories?: RawRepository[] };
    const list = Array.isArray(data) ? data : data?.repositories ?? [];
    return list.map(toSummary).filter(repository => repository.fullName);
  },
  async getRepository(token, id) {
    const [owner, name] = id.split("/");
    const raw = await request(token, "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name)) as RawRepository;
    return toSummary({ ...raw, full_name: raw.full_name ?? id });
  },
  importRepository: importFiles,
  commitUrl(repository, sha) {
    return repository.url.replace(/\/+$/, "") + "/commit/" + sha;
  },
};

/** OAuth-настройки для обновления токена: тот же getter, что и у маршрутов. */
export function gitverseOAuth() {
  return oauthSettings();
}
