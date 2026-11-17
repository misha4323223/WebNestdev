import { listProjectOwnersOnThisNode } from "../project-store.js";
import { hydratePreview } from "../preview/preview-store.js";
import { listSandboxJobs } from "../sandbox/jobs.js";
import { isRunActiveAnywhere } from "../agent/run-activity.js";
import { isLocalWorkspace, localProjectIds, workspaceMode } from "../sandbox/workspace-mode.js";
import { objectStoreConfigFromEnv } from "./object-store.js";
import { getProjectWorkspaceMeta } from "./project-workspace-store.js";
import { snapshotProject } from "./workspace-snapshot.js";

/**
 * Периодические горячие snapshot локальных проектов.
 *
 * Без них failover после потери ноды не может восстановить свежую работу: snapshot есть только
 * у проектов, которые кто-то снял вручную. Планировщик работает на каждой ноде и обходит только
 * свои проекты; занятые проекты (preview, задание, запуск агента) пропускаются, чтобы не снимать
 * tar с файлов, которые прямо сейчас пишутся.
 */

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const DEFAULT_MIN_AGE_MS = 10 * 60_000;

export function snapshotIntervalMs(value = process.env.WORKSPACE_SNAPSHOT_INTERVAL_MS): number {
  if (value?.trim() === "0") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS ? Math.floor(parsed) : DEFAULT_INTERVAL_MS;
}

function snapshotMinAgeMs(value = process.env.WORKSPACE_SNAPSHOT_MIN_AGE_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MIN_AGE_MS;
}

export async function snapshotLocalProjectsOnce(now = Date.now()): Promise<{ snapshotted: number; skipped: number; failed: number }> {
  const result = { snapshotted: 0, skipped: 0, failed: 0 };
  if (workspaceMode() !== "local" && localProjectIds().size === 0) return result;
  let projects;
  try {
    projects = await listProjectOwnersOnThisNode();
  } catch (error) {
    console.warn("[snapshot] список проектов не прочитан: " + (error instanceof Error ? error.message : String(error)));
    return result;
  }
  const minAge = snapshotMinAgeMs();
  for (const project of projects) {
    if (project.workspaceMode !== "local" && !isLocalWorkspace(project.id)) {
      result.skipped++;
      continue;
    }
    try {
      const meta = await getProjectWorkspaceMeta(project.id);
      if (meta?.snapshotAt && now - Date.parse(meta.snapshotAt) < minAge) {
        result.skipped++;
        continue;
      }
      if (await hydratePreview(project.id).catch(() => undefined)) {
        result.skipped++;
        continue;
      }
      if (listSandboxJobs(project.id).length) {
        result.skipped++;
        continue;
      }
      if (await isRunActiveAnywhere(project.id).catch(() => true)) {
        result.skipped++;
        continue;
      }
      await snapshotProject(project.id, project.userId);
      result.snapshotted++;
    } catch (error) {
      result.failed++;
      console.warn(
        "[snapshot] проект " + project.id + " не снят: " + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startWorkspaceSnapshotScheduler(): void {
  if (timer) return;
  if (workspaceMode() !== "local" && localProjectIds().size === 0) return;
  const interval = snapshotIntervalMs();
  if (!interval) return;
  try {
    if (!objectStoreConfigFromEnv()) {
      console.warn("[snapshot] локальный режим без PLATFORM_S3_*: периодические snapshot выключены");
      return;
    }
  } catch (error) {
    console.warn("[snapshot] конфигурация объектного хранилища неверна: " + (error instanceof Error ? error.message : String(error)));
    return;
  }
  timer = setInterval(() => {
    void snapshotLocalProjectsOnce().then(result => {
      if (result.snapshotted || result.failed) {
        console.log(
          "[snapshot] проход: создано " + result.snapshotted + ", пропущено " + result.skipped +
            ", ошибок " + result.failed,
        );
      }
    }).catch(error => console.warn("[snapshot] проход не удался: " + (error instanceof Error ? error.message : String(error))));
  }, interval);
  timer.unref?.();
  void snapshotLocalProjectsOnce().catch(error =>
    console.warn("[snapshot] первый проход не удался: " + (error instanceof Error ? error.message : String(error))),
  );
}

export function stopWorkspaceSnapshotScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
