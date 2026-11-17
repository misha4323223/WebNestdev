import { lstat, rm } from "node:fs/promises";
import { hostingConfig } from "./config.js";
import { hostingManifestPath, hostingReleaseDir, readCurrentReleaseId } from "./paths.js";
import { getSite, listReleases } from "./site-store.js";
import { withSiteLock } from "./site-lock.js";
import type { HostingRelease, HostingSite } from "./types.js";

/**
 * Локальный кэш релизов.
 *
 * Бакет — источник правды для истории, диск — только горячий слой. Поэтому старый готовый
 * релиз можно убрать с диска, не помечая его `deleted` и не удаляя объект из S3. Вернуть его
 * умеет `S3ReleaseStore.restore`, которым уже пользуются откат и reconcile.
 *
 * Вытесняем только релизы, у которых есть `storageKey`: без архива в бакете удаление
 * локальной копии сделало бы откат невозможным. Это же правило оставляет нетронутыми
 * релизы, опубликованные до включения S3.
 */

/** Сколько готовых релизов оставить на диске. Активный релиз входит в лимит. */
export function localReleaseIds(
  releases: HostingRelease[],
  activeReleaseId: string | null,
  keep: number,
): Set<string> {
  const ids = new Set<string>();
  if (activeReleaseId) ids.add(activeReleaseId);
  const limit = Math.max(1, Math.floor(keep));
  for (const release of releases) {
    if (ids.size >= limit) break;
    if (release.status !== "ready") continue;
    ids.add(release.id);
  }
  return ids;
}

export type LocalEviction = {
  removed: string[];
};

/**
 * Удаляет с диска готовые релизы вне локального кэша. Не трогает:
 * - активный релиз и `current` (даже если БД и ссылка на мгновение разошлись);
 * - релизы без `storageKey`;
 * - `building`, `failed` и `deleted` — у них свои правила очистки.
 */
export async function evictLocalReleases(input: {
  site: HostingSite;
  releases: HostingRelease[];
  activeReleaseId: string | null;
  keep: number;
  sitesDir?: string;
}): Promise<LocalEviction> {
  const sitesDir = input.sitesDir ?? hostingConfig().sitesDir;
  const keepIds = localReleaseIds(input.releases, input.activeReleaseId, input.keep);
  const current = await readCurrentReleaseId(input.site.slug, sitesDir).catch(() => null);
  const removed: string[] = [];

  for (const release of input.releases) {
    if (release.status !== "ready" || keepIds.has(release.id) || release.id === current) continue;
    // Без архива в бакете это единственная копия релиза. Оставляем её до появления S3.
    if (!release.storageKey.trim()) continue;

    const dir = hostingReleaseDir(input.site.slug, release.id, sitesDir);
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;

    await rm(dir, { recursive: true, force: true });
    await rm(hostingManifestPath(input.site.slug, release.id, sitesDir), { force: true });
    removed.push(release.id);
  }

  return { removed };
}

/**
 * Обёртка для публикатора: читает свежие site/releases уже после фиксации нового релиза и
 * сериализуется с откатом/сменой адреса через тот же per-site lock.
 */
export async function pruneLocalReleases(site: HostingSite): Promise<LocalEviction> {
  return withSiteLock(site.id, async () => {
    const fresh = await getSite(site.id);
    if (!fresh || fresh.status === "deleted") return { removed: [] };
    const releases = await listReleases(fresh.id, 100);
    return evictLocalReleases({
      site: fresh,
      releases,
      activeReleaseId: fresh.activeReleaseId,
      keep: hostingConfig().limits.keepLocalReleases,
      sitesDir: hostingConfig().sitesDir,
    });
  });
}
