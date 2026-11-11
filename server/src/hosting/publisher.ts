import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProject, type Project } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import type { SandboxConfig } from "../sandbox/sandbox-types.js";
import { ensureProjectDependencies } from "../preview/dependencies.js";
import { detectProject } from "../preview/project-kind.js";
import { indexFileExists, planStaticPreview } from "../preview/static-plan.js";
import { runInSandbox } from "../sandbox-worker.js";
import { secretEnvMaskMounts } from "../sandbox/secret-mask.js";
import { loadProjectSecretFiles } from "../secrets/project-secrets.js";
import { hostingConfig, hostingLimits } from "./config.js";
import { copyArtifact, inspectArtifact, removeStaging } from "./artifact.js";
import { purgeHostingCdn } from "./cdn-purge.js";
import { assertAccountHostingQuota, assertHostingDiskHasRoom } from "./limits.js";
import { publicEnvMounts } from "./public-env.js";
import { projectSecretValuesForScan, redactSecretText } from "./security.js";
import {
  activateRelease,
  beginPublish,
  failPublish,
  finishPublish,
  getRelease,
  getSite,
  listReleases,
  markReleaseDeleted,
  staleReleases,
} from "./site-store.js";
import {
  ensureSiteLayout,
  hostingManifestPath,
  hostingReleaseDir,
  hostingStagingPath,
  readCurrentReleaseId,
  removeCurrent,
  switchCurrent,
} from "./paths.js";
import { HostingError, type HostingProjectKind, type HostingRelease, type HostingSite } from "./types.js";
import { withSiteLock } from "./site-lock.js";
import {
  hostingReleaseStore,
  hostingReleaseStoreSafe,
  type ReleaseStore,
  type StoredRelease,
} from "./release-store.js";

/**
 * Публикация статического сайта.
 *
 * Порядок намеренно консервативный: build -> проверка -> staging -> rename -> current ->
 * транзакция БД. Старый `current` не трогается до успешной проверки, а если запись в БД
 * упала после переключения, `current` возвращается на прежний релиз.
 *
 * Build-слот ограничен на процесс (на одной ВМ это и есть нужный предел). Межрепличная
 * сериализация одной публикации обеспечивается частичным уникальным индексом `building` и
 * транзакцией в site-store; второй запрос получает 409, а не запускает вторую сборку.
 */

const BUILD_COMMAND = "npm run build";

type BuildSlot = { release: () => void };
let activeBuilds = 0;
const buildWaiters: Array<{ resolve: (slot: BuildSlot) => void; timer?: NodeJS.Timeout }> = [];

async function acquireBuildSlot(timeoutMs: number): Promise<BuildSlot> {
  if (activeBuilds < hostingConfig().limits.buildConcurrency) {
    activeBuilds++;
    return { release: releaseBuildSlot };
  }
  return new Promise<BuildSlot>((resolve, reject) => {
    const waiter = {
      resolve: (slot: BuildSlot) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(slot);
      },
      timer: setTimeout(() => {
        const index = buildWaiters.indexOf(waiter);
        if (index >= 0) buildWaiters.splice(index, 1);
        reject(new HostingError("SITE_BUSY", "Очередь публикаций занята, попробуйте позже", 429));
      }, Math.max(5_000, timeoutMs)),
    };
    buildWaiters.push(waiter);
  });
}

function releaseBuildSlot() {
  const next = buildWaiters.shift();
  if (next) {
    next.resolve({ release: releaseBuildSlot });
    return;
  }
  activeBuilds = Math.max(0, activeBuilds - 1);
}

async function withBuildSlot<T>(timeoutMs: number, action: () => Promise<T>): Promise<T> {
  const slot = await acquireBuildSlot(timeoutMs);
  try {
    return await action();
  } finally {
    slot.release();
  }
}

function projectOnThisNode(project: Project) {
  const config = hostingConfig();
  if (project.node && project.node !== config.nodeId && !config.sharedStorage) {
    throw new HostingError(
      "PROJECT_REMOTE",
      "Проект закреплён за узлом " + project.node + ". Публикация с этого узла невозможна без общего SITES_DIR; " +
        "включите WEBNESTDEV_SHARED_SANDBOX=1 и HOSTING_SHARED_STORAGE=1 или публикуйте через узел проекта.",
      503,
    );
  }
}

function logLine(level: "info" | "warn" | "error", message: string, details: Record<string, unknown> = {}) {
  const suffix = Object.entries(details)
    .map(([key, value]) => key + "=" + String(value))
    .join(" ");
  const line = "[hosting] " + message + (suffix ? " " + suffix : "");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Запускает публикацию и сразу возвращает `{site, release}` для ответа 202. Ошибки после
 * старта попадают в релиз и `site.last_error`, а не в уже закрытый HTTP-ответ.
 */
export async function startPublish(siteId: string, userId: string): Promise<{ site: HostingSite; release: HostingRelease }> {
  return withSiteLock(siteId, () => startPublishLocked(siteId, userId));
}

async function startPublishLocked(siteId: string, userId: string): Promise<{ site: HostingSite; release: HostingRelease }> {
  const config = hostingConfig();
  if (!config.enabled) throw new HostingError("HOSTING_DISABLED", "Публикация сайтов пока недоступна", 503);
  const site = await getSite(siteId);
  if (!site || site.userId !== userId || site.status === "deleted") {
    throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
  }
  if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
  if (site.nodeId && site.nodeId !== config.nodeId && !config.sharedStorage) {
    throw new HostingError(
      "PROJECT_REMOTE",
      "Сайт закреплён за узлом " + site.nodeId + "; с этого узла файлы не видны. Включите общий SITES_DIR или работайте через узел сайта.",
      503,
    );
  }
  const project = await getProject(site.projectId);
  if (!project || project.userId !== userId) throw new HostingError("PROJECT_NOT_FOUND", "Проект не найден", 404);
  projectOnThisNode(project);

  const kind = await hostingKind(project);
  const started = await beginPublish({ siteId: site.id, userId, kind, nodeId: config.nodeId });
  // Публикация выполняется в фоне: HTTP не должен держать запрос 10 минут. Ошибка уже
  // записана в release/site, поэтому дополнительно её только логируем.
  void runPublish(started.site, started.release, project, kind).catch(error => {
    logLine("error", "publish crashed", { site: site.slug, error: error instanceof Error ? error.message : String(error) });
  });
  return started;
}

/**
 * Переключает сайт на уже опубликованный готовый релиз. Файлы не копируются: релиз
 * неизменяем, поэтому достаточно проверить каталог, переключить `current` и зафиксировать
 * active_release_id в БД. При ошибке БД возвращаем прежнюю ссылку.
 */
export async function startRollback(
  siteId: string,
  userId: string,
  releaseId: string,
): Promise<{ site: HostingSite; release: HostingRelease }> {
  return withSiteLock(siteId, () => startRollbackLocked(siteId, userId, releaseId));
}

async function startRollbackLocked(
  siteId: string,
  userId: string,
  releaseId: string,
): Promise<{ site: HostingSite; release: HostingRelease }> {
  const config = hostingConfig();
  if (!config.enabled) throw new HostingError("HOSTING_DISABLED", "Публикация сайтов пока недоступна", 503);
  const site = await getSite(siteId);
  if (!site || site.userId !== userId || site.status === "deleted") {
    throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
  }
  if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт снят администратором", 409);
  if (site.nodeId && site.nodeId !== config.nodeId && !config.sharedStorage) {
    throw new HostingError("PROJECT_REMOTE", "Сайт закреплён за другим узлом; включите общий SITES_DIR", 503);
  }
  const release = await getRelease(releaseId);
  if (!release || release.siteId !== site.id) throw new HostingError("RELEASE_NOT_READY", "Релиз не найден", 404);
  if (release.status !== "ready") throw new HostingError("RELEASE_NOT_READY", "Откатиться можно только на готовый релиз", 409);

  await ensureSiteLayout(site.slug, config.sitesDir);
  const releaseDir = hostingReleaseDir(site.slug, release.id, config.sitesDir);
  const local = await lstat(releaseDir).catch(() => null);
  if (!local?.isDirectory()) {
    // Локальный кэш мог не пережить потерю диска. Архив в бакете — единственный способ
    // вернуть старый релиз без повторной сборки проекта.
    const store = hostingReleaseStore();
    if (!store) {
      throw new HostingError("RELEASE_NOT_READY", "Файлы выбранного релиза не найдены на этом узле", 409);
    }
    await store.restore({ site, release, dir: releaseDir });
  }
  let previous: string | null;
  try {
    previous = await switchCurrent(site.slug, release.id, config.sitesDir);
  } catch {
    throw new HostingError("RELEASE_NOT_READY", "Файлы выбранного релиза не найдены на этом узле", 409);
  }
  try {
    return await activateRelease({ siteId: site.id, userId, releaseId: release.id });
  } catch (error) {
    // Если сайт успели удалить или снять, не возвращаем старую ссылку: это снова сделало бы
    // его доступным. В остальных случаях сохраняем работающий релиз.
    let hidden = true;
    try {
      const latest = await getSite(site.id);
      hidden = !latest || latest.status === "deleted" || latest.status === "unpublished" || latest.status === "suspended";
    } catch {
      hidden = true;
    }
    if (hidden || !previous) await removeCurrent(site.slug, config.sitesDir).catch(() => undefined);
    else await switchCurrent(site.slug, previous, config.sitesDir).catch(() => undefined);
    throw error;
  }
}

async function hostingKind(project: Project): Promise<HostingProjectKind> {
  const sandbox = await getSandbox(project.id, project.userId);
  const shape = await detectProject(sandbox.root);
  if (shape.kind === "instant-site" || shape.kind === "static-build") return shape.kind;
  throw new HostingError("PROJECT_NOT_STATIC", "Хостинг пока умеет только статические сайты: " + shape.reason, 422);
}

async function buildStatic(
  config: SandboxConfig,
  site: HostingSite,
  secretValues: string[],
): Promise<{ log: string; sourceDir: string }> {
  const limits = hostingLimits();
  const publicEnv = await publicEnvMounts(config);
  // Маски идут раньше публичного env: существующий `.env.local` закрывается пустым файлом,
  // затем поверх монтируется только allowlist публичных переменных.
  const masks = await secretEnvMaskMounts(config);
  const extraMounts = [...masks, ...publicEnv.mounts];
  let log = "";
  try {
    const dependencies = await ensureProjectDependencies(
      config,
      runInSandbox,
      { injectSecretEnvFile: false, maskSecretEnvFiles: false, extraMounts },
    );
    if (!dependencies.ok) throw new HostingError("BUILD_FAILED", dependencies.reason, 422);
    log += dependencies.log;
    const result = await runInSandbox(config, BUILD_COMMAND, config.root, {
      network: "none",
      injectSecretEnvFile: false,
      maskSecretEnvFiles: false,
      extraMounts,
      timeoutMs: limits.buildTimeoutMs,
    });
    const output = [result.stdout, result.stderr].map(value => value.replace(/\r/g, "").trim()).filter(Boolean).join("\n");
    log += (log ? "\n" : "") + "$ " + BUILD_COMMAND + (result.ok ? "" : " -> код " + result.exitCode) + "\n" + output;
    if (!result.ok) {
      throw new HostingError("BUILD_FAILED", "Сборка завершилась с кодом " + result.exitCode, 422);
    }
    const plan = await planStaticPreview(config);
    if (!plan.ok) throw new HostingError("BUILD_FAILED", "Не удалось определить каталог сборки: " + plan.reason, 422);
    if (!(await indexFileExists(plan.dir))) {
      throw new HostingError("BUILD_FAILED", "Сборка не создала index.html в " + path.basename(plan.dir), 422);
    }
    return { log: redactSecretText(log, secretValues), sourceDir: plan.dir };
  } catch (error) {
    // Лог неудачной сборки нужен пользователю в release.buildLog, но значения секретов
    // уже могли попасть в stdout. Redaction выполняется до записи, а не при показе.
    if (error && typeof error === "object") {
      (error as { hostingBuildLog?: string }).hostingBuildLog = redactSecretText(log, secretValues);
    }
    throw error;
  } finally {
    await publicEnv.cleanup().catch(() => undefined);
  }
}

async function runPublish(site: HostingSite, release: HostingRelease, project: Project, kind: HostingProjectKind) {
  const config = hostingConfig();
  const limits = config.limits;
  const startedAt = Date.now();
  let sourceDir = "";
  let staging = "";
  let targetDir = "";
  let manifestPath = "";
  let switched = false;
  let committed = false;
  let previousRelease: string | null = null;
  let buildLog = "";
  let secretValues: string[] = [];
  let publishedBytes = 0;
  let releaseStore: ReleaseStore | null = null;
  let stored: StoredRelease | null = null;

  try {
    releaseStore = hostingReleaseStore();
    await withBuildSlot(limits.maxReleaseSeconds * 1000, async () => {
      await ensureSiteLayout(site.slug, config.sitesDir);
      const sandbox = await getSandbox(project.id, project.userId);
      const shape = await detectProject(sandbox.root);
      if (shape.kind !== kind) {
        throw new HostingError("PROJECT_NOT_STATIC", "Тип проекта изменился во время публикации: " + shape.reason, 422);
      }

      const secretFiles = await loadProjectSecretFiles(project.id, sandbox.root);
      secretValues = await projectSecretValuesForScan(secretFiles);

      if (kind === "instant-site") {
        const plan = await planStaticPreview(sandbox);
        if (!plan.ok) throw new HostingError("PROJECT_NOT_STATIC", plan.reason, 422);
        sourceDir = plan.dir;
        if (!(await indexFileExists(sourceDir))) throw new HostingError("BUILD_FAILED", "Нет index.html", 422);
      } else {
        const build = await buildStatic(sandbox, site, secretValues);
        buildLog = build.log;
        sourceDir = build.sourceDir;
      }

      const inspected = await inspectArtifact(sourceDir, {
        limits,
        secretValues,
        projectRoot: sandbox.root,
        allowSourceMaps: process.env.HOSTING_ALLOW_SOURCEMAPS === "1",
      });
      publishedBytes = inspected.bytes;
      await assertAccountHostingQuota(project.userId, inspected.bytes);
      await assertHostingDiskHasRoom(config, inspected.bytes);

      staging = hostingStagingPath(site.slug, release.id, config.sitesDir);
      await removeStaging(staging);
      await copyArtifact(sourceDir, staging, inspected, {
        limits,
        secretValues,
        projectRoot: sandbox.root,
        allowSourceMaps: process.env.HOSTING_ALLOW_SOURCEMAPS === "1",
      });

      const target = hostingReleaseDir(site.slug, release.id, config.sitesDir);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      staging = "";
      targetDir = target;

      manifestPath = hostingManifestPath(site.slug, release.id, config.sitesDir);
      await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o755 });
      await writeFile(manifestPath, JSON.stringify(inspected), { encoding: "utf8", mode: 0o644 });

      // Архив загружается до переключения current: если S3 недоступен, старый сайт должен
      // продолжать работать, а не замениться релизом, которого нет в источнике правды.
      if (releaseStore) {
        stored = await releaseStore.put({ site, releaseId: release.id, dir: target, manifest: inspected });
        logLine("info", "release archived", {
          site: site.slug,
          release: release.id,
          bytes: stored.storedBytes,
          key: stored.storageKey,
        });
      }

      previousRelease = await switchCurrent(site.slug, release.id, config.sitesDir);
      switched = true;

      try {
        await finishPublish({
          siteId: site.id,
          releaseId: release.id,
          userId: project.userId,
          kind,
          bytes: inspected.bytes,
          storedBytes: stored?.storedBytes ?? inspected.bytes,
          files: inspected.filesCount,
          sha256: inspected.sha256,
          manifestJson: JSON.stringify(inspected),
          storageKey: stored?.storageKey ?? "",
          manifestKey: stored?.manifestKey ?? "",
        });
        committed = true;
      } catch (error) {
        // Если сайт успели снять с публикации, current не восстанавливаем: решение
        // модератора/пользователя важнее неудачной гонки публикатора.
        const blocked = error instanceof HostingError && (error.code === "SITE_SUSPENDED" || error.code === "SITE_DELETED" || error.code === "SITE_NOT_FOUND");
        if (blocked) await removeCurrent(site.slug, config.sitesDir).catch(() => undefined);
        else if (previousRelease) await switchCurrent(site.slug, previousRelease, config.sitesDir).catch(() => undefined);
        else await removeCurrent(site.slug, config.sitesDir).catch(() => undefined);
        switched = false;
        throw error;
      }
    });

    // Старые релизы удаляются только после успешной публикации и только сверх лимита.
    await pruneOldReleases(site, release.id, limits.keepReleases, config.sitesDir);
    // Сброс кеша CDN — после успешной фиксации релиза. Ошибка purge не отменяет публикацию:
    // HTML не кешируется, а ассеты доживут до TTL; важнее не оставить сайт в failed.
    try {
      const purged = await purgeHostingCdn(site.slug);
      if (!purged.skipped) logLine("info", "cdn purge requested", { site: site.slug, task: purged.task });
    } catch (error) {
      logLine("warn", "cdn purge failed", {
        site: site.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logLine("info", "publish ok", {
      site: site.slug,
      release: release.id,
      kind,
      bytes: publishedBytes,
      files: release.files,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!buildLog && error && typeof error === "object" && typeof (error as { hostingBuildLog?: string }).hostingBuildLog === "string") {
      buildLog = (error as { hostingBuildLog?: string }).hostingBuildLog ?? "";
    }
    if (staging) await removeStaging(staging);
    // Релиз, не дошедший до успешной фиксации в БД, не должен оставаться на диске
    // невидимым мусором: `reconcile` не удаляет каталог, пока строка релиза существует.
    // Не трогаем каталог, если current всё ещё указывает на него (откат ссылки не удался).
    if (!committed && targetDir) {
      try {
        const current = await readCurrentReleaseId(site.slug, config.sitesDir).catch(() => "unknown");
        if (current !== release.id) {
          await rm(targetDir, { recursive: true, force: true });
          if (manifestPath) await rm(manifestPath, { force: true });
        } else {
          logLine("warn", "failed release is still current", { site: site.slug, release: release.id });
        }
      } catch (cleanupError) {
        logLine("warn", "failed release cleanup skipped", {
          site: site.slug,
          release: release.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
    if (switched) {
      try {
        // Если пользователь снял сайт или администратор приостановил его, пока шла сборка,
        // восстанавливать старый current нельзя: это снова сделало бы сайт доступным.
        const latest = await getSite(site.id);
        const hidden = latest?.status === "unpublished" || latest?.status === "suspended" || latest?.status === "deleted";
        if (hidden || !previousRelease) await removeCurrent(site.slug, config.sitesDir);
        else await switchCurrent(site.slug, previousRelease, config.sitesDir);
      } catch (restoreError) {
        logLine("error", "current rollback failed", { site: site.slug, error: restoreError instanceof Error ? restoreError.message : String(restoreError) });
      }
    }
    if (!committed && releaseStore) {
      // Релиз не записан в БД — его объекты никто не найдёт. Ключи детерминированные,
      // поэтому чистим и тот случай, когда put упал после загрузки архива.
      const keys = stored ?? releaseStore.keys(site, release.id);
      await releaseStore.removeKeys(keys.storageKey, keys.manifestKey).catch(cleanupError => {
        logLine("warn", "release objects cleanup failed", {
          site: site.slug,
          release: release.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    }
    if (!committed) {
      await failPublish({
        siteId: site.id,
        releaseId: release.id,
        error: message.slice(0, 1_000),
        buildLog: redactSecretText(buildLog, secretValues),
      }).catch(failError => logLine("error", "failPublish failed", { site: site.slug, error: failError instanceof Error ? failError.message : String(failError) }));
      logLine("error", "publish failed", { site: site.slug, release: release.id, error: message.slice(0, 240) });
    } else {
      // Публикация уже зафиксирована; ошибка после неё (например, очистка старых релизов)
      // не должна превращать успешный релиз в failed.
      logLine("warn", "publish committed with cleanup error", { site: site.slug, release: release.id, error: message.slice(0, 240) });
    }
  }
}

export async function pruneOldReleases(site: HostingSite, activeReleaseId: string, keep: number, sitesDir = hostingConfig().sitesDir) {
  const stale = await staleReleases(site.id, activeReleaseId, keep);
  const store = hostingReleaseStoreSafe();
  for (const release of stale) {
    if (release.id === activeReleaseId) continue;
    const dir = hostingReleaseDir(site.slug, release.id, sitesDir);
    try {
      // Сначала занимаем строку статусом `deleted`: иначе гонка с откатом могла сделать
      // этот релиз активным уже после удаления файлов. Если claim не удался — файлы целы.
      if (!(await markReleaseDeleted(release.id))) continue;
      await rm(dir, { recursive: true, force: true });
      await rm(hostingManifestPath(site.slug, release.id, sitesDir), { force: true });
      // Строка уже помечена deleted: активным этот релиз стать не может, объект больше
      // не нужен. Ошибка S3 не отменяет публикацию — только оставляет объект на разбор.
      if (store) {
        await store.remove({ site, release }).catch(error => {
          logLine("warn", "old release object cleanup failed", {
            site: site.slug,
            release: release.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      logLine("warn", "old release cleanup failed", {
        site: site.slug,
        release: release.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Для reconcile: временные каталоги, которые не соответствуют ни одному активному релизу. */
export async function cleanupStaging(site: HostingSite, sitesDir = hostingConfig().sitesDir) {
  const releases = await listReleases(site.id, 100);
  const building = new Set(releases.filter(release => release.status === "building").map(release => release.id));
  const dir = path.join(path.dirname(hostingReleaseDir(site.slug, "000000000000", sitesDir)), "..", "tmp");
  const entries = await readdir(path.resolve(dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || building.has(entry.name)) continue;
    await rm(path.join(path.resolve(dir), entry.name), { recursive: true, force: true }).catch(() => undefined);
  }
}

export { BUILD_COMMAND };
