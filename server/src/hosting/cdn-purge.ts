/**
 * Сброс кеша CDN после публикации сайта.
 *
 * CDN-ресурс общий для всех сайтов (`*.host...`), а MWS purge принимает только пути внутри
 * ресурса, без имени сайта. Поэтому чистим не `/*`, а только не-хешированные файлы нового
 * релиза: HTML и обычные `/assets/logo.png`. Хешированные ассеты неизменяемы и в purge не
 * нуждаются. Это всё ещё общий ресурс: одинаковый путь у другого сайта тоже станет MISS.
 * Полная изоляция требует отдельного CDN-ресурса на сайт или cache key по Host.
 *
 * Ошибка purge не должна ломать публикацию: HTML отдаётся с `no-cache`, а ассеты живут
 * до TTL. Вызывающий код логирует ошибку и продолжает.
 */

import { mwsRequest } from "../mws/mws-auth.js";

export type HostingCdnConfig = { project: string; resource: string };

export type HostingCdnPurgeDeps = {
  request?: typeof mwsRequest;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
};

export type HostingCdnPurgeResult =
  | { skipped: true }
  | { skipped: false; task: string };

const ENABLED = /^(1|true|yes|on)$/i;
const KEY_PROJECT = /^projects\/([^/]+)\//;
const HASHED_ASSET = /-[A-Za-z0-9_-]{6,}\.[a-z0-9]{1,8}$/i;
const SAFE_PURGE_PATH = /^[A-Za-z0-9._~\/-]+$/;
const MAX_PURGE_PATHS = 100;

/** Конфигурация из окружения; `null`, если purge выключен или не задан проект. */
export function hostingCdnConfig(env: NodeJS.ProcessEnv = process.env): HostingCdnConfig | null {
  if (!ENABLED.test((env.HOSTING_CDN_PURGE ?? "").trim())) return null;
  const resource = (env.HOSTING_CDN_RESOURCE ?? "hosting").trim();
  if (!resource) return null;
  const project =
    (env.HOSTING_CDN_PROJECT ?? "").trim() ||
    KEY_PROJECT.exec(env.MWS_SA_KEY_ID ?? "")?.[1] ||
    "";
  if (!project) return null;
  return { project, resource };
}

/**
 * Пути, которые действительно могли закешироваться: HTML и файлы без хеша в имени.
 * `/` и `/index.html` — один и тот же документ, но CDN может помнить оба варианта.
 */
export function purgePathsForArtifact(manifest: { files: ReadonlyArray<{ path: string }> }): string[] {
  return pathsForFiles(manifest.files);
}

/**
 * Только файлы, которые изменились относительно предыдущего релиза. Хешированные ассеты
 * исключены: у них новый URL при новом содержимом, старый кеш безвреден. Если предыдущего
 * манифеста нет, чистим все не-хешированные файлы нового релиза.
 */
export function purgePathsForChange(
  next: { files: ReadonlyArray<{ path: string; sha256?: string }> },
  previousManifestJson: string,
): string[] {
  const previous = previousFiles(previousManifestJson);
  if (!previous) return pathsForFiles(next.files);
  const changed = next.files.filter(file => !HASHED_ASSET.test(file.path) && previous.get(file.path) !== file.sha256);
  return pathsForFiles(changed);
}

function pathsForFiles(files: ReadonlyArray<{ path: string }>): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (HASHED_ASSET.test(file.path)) continue;
    // CDN принимает пути как регулярные выражения. Не отдаём ему `*`, `?`, `[` и пробелы
    // из имени файла: иначе purge мог бы задеть чужие пути.
    if (!SAFE_PURGE_PATH.test(file.path)) continue;
    if (file.path === "index.html") paths.add("/");
    const path = "/" + encodePath(file.path);
    paths.add(path);
    if (file.path === "index.html") paths.add("/index.html");
    if (paths.size > MAX_PURGE_PATHS) return ["/*"];
  }
  return paths.size ? [...paths] : [];
}

function previousFiles(manifestJson: string): Map<string, string> | null {
  try {
    const parsed = JSON.parse(manifestJson) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return null;
    const map = new Map<string, string>();
    for (const file of parsed.files) {
      if (!file || typeof file !== "object") continue;
      const path = (file as { path?: unknown }).path;
      const sha256 = (file as { sha256?: unknown }).sha256;
      if (typeof path === "string") map.set(path, typeof sha256 === "string" ? sha256 : "");
    }
    return map;
  } catch {
    return null;
  }
}

/** Разбор сохранённого манифеста релиза; битый манифест — повод для полного purge. */
export function purgePathsForManifest(manifestJson: string): string[] {
  const files = previousFiles(manifestJson);
  if (!files) return ["/*"];
  const paths = pathsForFiles([...files.keys()].map(path => ({ path })));
  return paths.length ? paths : ["/*"];
}

function encodePath(value: string) {
  return value.split("/").map(segment => encodeURIComponent(segment)).join("/");
}

function normalizePaths(paths: readonly string[] | undefined): string[] {
  const unique = [...new Set((paths ?? ["/*"]).filter(path => path.startsWith("/") && !/[\r\n]/.test(path)))];
  return unique.length ? unique.slice(0, MAX_PURGE_PATHS) : ["/*"];
}

/** Имя задачи: латиница/цифры/дефис, не длиннее 63 символов (ограничение API). */
export function purgeTaskName(siteSlug: string, now = Date.now()): string {
  const safe = siteSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "site";
  return "purge-" + safe + "-" + now.toString(36);
}

/**
 * Ставит задачу purge в CDN. Возвращает имя задачи либо `{skipped:true}`, если purge
 * выключен. Бросает ошибку при отказе API — решение, как реагировать, остаётся за
 * вызывающим кодом.
 */
export async function purgeHostingCdn(
  siteSlug: string,
  deps: HostingCdnPurgeDeps = {},
  paths?: readonly string[],
): Promise<HostingCdnPurgeResult> {
  const env = deps.env ?? process.env;
  const config = hostingCdnConfig(env);
  if (!config) return { skipped: true };

  if (paths && !paths.length) return { skipped: true };
  const now = deps.now?.() ?? Date.now();
  const task = purgeTaskName(siteSlug, now);
  const purgePaths = normalizePaths(paths);
  const path =
    "/cdn/v1/projects/" +
    encodeURIComponent(config.project) +
    "/cacheTasks/" +
    encodeURIComponent(task);
  const request = deps.request ?? mwsRequest;
  const response = await request({
    method: "POST",
    path,
    body: {
      metadata: { name: task },
      spec: {
        resource: config.resource,
        action: { purge: { paths: purgePaths } },
      },
    },
  });
  if (!response.ok) {
    throw new Error("CDN purge отклонён: HTTP " + response.status);
  }
  return { skipped: false, task };
}
