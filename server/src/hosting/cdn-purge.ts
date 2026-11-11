/**
 * Сброс кеша CDN после публикации сайта.
 *
 * CDN-ресурс общий для всех сайтов (`*.host...`), поэтому purge чистит весь ресурс.
 * Это осознанный компромисс: после публикации один раз сбрасывается кеш всех сайтов,
 * зато старые ассеты не залипают и не нужен отдельный CDN-ресурс на каждый сайт.
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
): Promise<HostingCdnPurgeResult> {
  const env = deps.env ?? process.env;
  const config = hostingCdnConfig(env);
  if (!config) return { skipped: true };

  const now = deps.now?.() ?? Date.now();
  const task = purgeTaskName(siteSlug, now);
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
        action: { purge: { paths: ["/*"] } },
      },
    },
  });
  if (!response.ok) {
    throw new Error("CDN purge отклонён: HTTP " + response.status);
  }
  return { skipped: false, task };
}
