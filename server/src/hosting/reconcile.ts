import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { hostingConfig } from "./config.js";
import { ensureSiteLayout, hostingManifestsDir, hostingReleaseDir, hostingReleasesDir, hostingTmpDir, readCurrentReleaseId, removeCurrent, removeSiteDirectory, switchCurrent } from "./paths.js";
import { getRelease, listReleases, listSites, markStaleBuilds } from "./site-store.js";

/**
 * Startup/periodic reconciliation. Файловая система — источник истины для `current`, БД —
 * для active_release_id. При падении между rename и транзакцией они расходятся; здесь
 * ссылка приводится к БД, а каталоги без строк релизов удаляются.
 *
 * На нескольких ВМ без общего SITES_DIR узел видит только свои каталоги. Поэтому сайты,
 * закреплённые за другим узлом, не «исправляются» и не удаляются: решение принимает узел,
 * которому принадлежат файлы.
 */

export type ReconcileResult = {
  staleBuilds: number;
  sitesChecked: number;
  currentRepaired: number;
  orphanDirectoriesRemoved: number;
  errors: number;
};

async function safely(action: () => Promise<void>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    console.warn("[hosting] reconcile step failed:", error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function removeDirectoryIfExists(dir: string) {
  const info = await lstat(dir).catch(() => null);
  if (info) await rm(dir, { recursive: true, force: true });
}

export async function reconcileHosting(): Promise<ReconcileResult> {
  const config = hostingConfig();
  if (!config.enabled) return { staleBuilds: 0, sitesChecked: 0, currentRepaired: 0, orphanDirectoriesRemoved: 0, errors: 0 };
  const result: ReconcileResult = { staleBuilds: 0, sitesChecked: 0, currentRepaired: 0, orphanDirectoriesRemoved: 0, errors: 0 };
  result.staleBuilds = await markStaleBuilds(Math.max(config.limits.maxReleaseSeconds * 2_000, 60_000)).catch(error => {
    result.errors++;
    console.warn("[hosting] markStaleBuilds failed:", error instanceof Error ? error.message : String(error));
    return 0;
  });

  const sites = await listSites({ limit: 1_000 });
  for (const site of sites) {
    // Файлы удалённого сайта остаются, если сервер упал между tombstone и очисткой.
    // Удаляем их только на узле, которому принадлежат; на общем SITES_DIR — на любом.
    if (site.status === "deleted") {
      if (site.nodeId && site.nodeId !== config.nodeId && !config.sharedStorage) continue;
      await safely(async () => {
        await removeCurrent(site.slug, config.sitesDir);
        await removeSiteDirectory(site.slug, config.sitesDir);
        result.orphanDirectoriesRemoved++;
      }).then(ok => { if (!ok) result.errors++; });
      continue;
    }
    if (site.nodeId && site.nodeId !== config.nodeId && !config.sharedStorage) continue;
    result.sitesChecked++;
    await safely(async () => {
      await ensureSiteLayout(site.slug, config.sitesDir);
      const releases = await listReleases(site.id, 100);
      const releaseById = new Map(releases.map(release => [release.id, release]));
      const active = site.activeReleaseId;
      // Активный релиз читаем отдельно: он может быть старше окна истории в 100 строк
      // после отката, и тогда `releaseById` ошибочно снял бы работающий `current`.
      const activeRelease = active ? await getRelease(active) : null;
      const current = await readCurrentReleaseId(site.slug, config.sitesDir).catch(() => null);

      if (site.status === "live" && active) {
        if (!activeRelease || activeRelease.siteId !== site.id || activeRelease.status !== "ready") {
          // Строка активного релиза потеряна или больше не готова. Не оставляем Caddy
          // отдавать неизвестный/неудачный каталог: снимаем current до следующей публикации.
          if (await removeCurrent(site.slug, config.sitesDir)) result.currentRepaired++;
        } else if (current !== active) {
          const exists = await lstat(hostingReleaseDir(site.slug, active, config.sitesDir)).catch(() => null);
          if (exists?.isDirectory()) {
            await switchCurrent(site.slug, active, config.sitesDir);
            result.currentRepaired++;
          } else {
            await removeCurrent(site.slug, config.sitesDir);
            result.currentRepaired++;
          }
        }
      } else if (current) {
        await removeCurrent(site.slug, config.sitesDir);
        result.currentRepaired++;
      }

      // Каталог релиза без строки в БД — остаток упавшего rename/старой версии. Не трогаем
      // `building`: его может писать живой build-процесс на этом же узле.
      const building = new Set(releases.filter(release => release.status === "building").map(release => release.id));
      const releaseEntries = await readdir(hostingReleasesDir(site.slug, config.sitesDir), { withFileTypes: true }).catch(() => []);
      for (const entry of releaseEntries) {
        if (!entry.isDirectory() || building.has(entry.name)) continue;
        const release = releaseById.get(entry.name);
        // Готовый релиз ещё нужен для отката; failed/deleted и каталоги без строки — мусор.
        if (release && release.status === "ready") continue;
        await removeDirectoryIfExists(path.join(hostingReleasesDir(site.slug, config.sitesDir), entry.name));
        result.orphanDirectoriesRemoved++;
      }

      const manifestEntries = await readdir(hostingManifestsDir(site.slug, config.sitesDir), { withFileTypes: true }).catch(() => []);
      for (const entry of manifestEntries) {
        const id = entry.name.replace(/\.json$/, "");
        if (!entry.isFile()) continue;
        const release = releaseById.get(id);
        if (release && release.status === "ready") continue;
        await rm(path.join(hostingManifestsDir(site.slug, config.sitesDir), entry.name), { force: true });
      }

      const tmpEntries = await readdir(hostingTmpDir(site.slug, config.sitesDir), { withFileTypes: true }).catch(() => []);
      for (const entry of tmpEntries) {
        if (!entry.isDirectory() || building.has(entry.name)) continue;
        await removeDirectoryIfExists(path.join(hostingTmpDir(site.slug, config.sitesDir), entry.name));
        result.orphanDirectoriesRemoved++;
      }
    }).then(ok => {
      if (!ok) result.errors++;
    });
  }
  if (result.sitesChecked) {
    console.log(
      "[hosting] reconcile sites=" + result.sitesChecked +
        " staleBuilds=" + result.staleBuilds +
        " currentRepaired=" + result.currentRepaired +
        " orphans=" + result.orphanDirectoriesRemoved +
        " errors=" + result.errors,
    );
  }
  return result;
}

/** Очистка одного сайта используется при удалении проекта, когда БД уже помечена deleted. */
export async function reconcileSite(siteId: string): Promise<void> {
  const config = hostingConfig();
  const site = (await listSites({ limit: 1_000 })).find(item => item.id === siteId);
  if (!site) return;
  await removeCurrent(site.slug, config.sitesDir).catch(() => undefined);
  await removeSiteDirectory(site.slug, config.sitesDir).catch(() => undefined);
}
