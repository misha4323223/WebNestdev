import { getProject, WorkspaceMigrationRequiredError } from "../project-store.js";
import { getNode } from "../nodes/node-store.js";
import { nodeId } from "../nodes/identity.js";
import { internalToken } from "../nodes/internal-auth.js";
import { ownerTarget } from "../nodes/owner-router.js";
import { isLocalWorkspace } from "../sandbox/workspace-mode.js";
import { hydratePreview } from "../preview/preview-store.js";
import { listSandboxJobs } from "../sandbox/jobs.js";
import { isRunActiveAnywhere } from "../agent/run-activity.js";
import { isYdbEnabled, withAdvisoryLock } from "./ydb.js";
import { getProjectWorkspaceMeta, moveProjectWorkspace, type ProjectWorkspaceMeta } from "./project-workspace-store.js";
import { snapshotProject } from "./workspace-snapshot.js";

/**
 * Перенос локального проекта на другую ноду.
 *
 * Порядок выбран так, чтобы pin менялся последним: сначала snapshot на источнике, затем restore
 * на цели, и только после подтверждения — смена `project.node`/epoch. Если restore упал, проект
 * остаётся на источнике и продолжает работать; если упала смена pin, на цели есть копия, а
 * источник всё ещё владелец — операцию можно повторить.
 *
 * Функция должна исполняться на ноде-владельце: owner-routing отправляет сюда админский запрос.
 */

const localLocks = new Map<string, Promise<unknown>>();

async function withLocalLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  localLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (localLocks.get(key) === current) localLocks.delete(key);
  }
}

async function withMigrationLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
  const key = "workspace-migrate:" + projectId;
  if (!isYdbEnabled()) return withLocalLock(key, action);
  const result = await withAdvisoryLock(key, action);
  if (result === null) throw new WorkspaceMigrationRequiredError("Миграция этого проекта уже выполняется");
  return result;
}

function targetUrl(apiAddress: string): string | null {
  const target = ownerTarget(apiAddress);
  if (!target) return null;
  const host = target.hostname.includes(":") ? "[" + target.hostname + "]" : target.hostname;
  return target.protocol + "//" + host + ":" + target.port + "/api/internal/workspace/restore";
}

export type MigrationResult = {
  projectId: string;
  from: string;
  to: string;
  snapshotKey: string;
  bytes: number;
  workspaceEpoch: number;
};

async function restoreOnTarget(projectId: string, userId: string, targetNode: string): Promise<void> {
  const target = await getNode(targetNode);
  if (!target || target.status === "offline") throw new Error("Целевой узел " + targetNode + " недоступен");
  if (target.workspaceMode !== "local") {
    throw new WorkspaceMigrationRequiredError("Целевой узел " + targetNode + " не работает в локальном режиме workspace");
  }
  if (!target.apiAddress.trim()) throw new Error("У целевого узла не задан внутренний API-адрес");
  const url = targetUrl(target.apiAddress);
  if (!url) throw new Error("Некорректный внутренний API-адрес целевого узла");
  const token = internalToken();
  if (token.length < 32) throw new Error("WEBNESTDEV_INTERNAL_TOKEN не задан: восстановление невозможно");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webnestdev-internal": "1",
      "x-webnestdev-internal-token": token,
    },
    body: JSON.stringify({ projectId, userId }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error("Целевая нода не восстановила snapshot: HTTP " + response.status + " " + text.slice(0, 300));
  }
}

/**
 * Восстановление проекта, чья нода уже потеряна. Snapshot обязателен: без него pin-only перенос
 * создал бы пустой проект. Вызывается с живой ноды после подтверждения потери.
 */
export async function restoreLostWorkspaceToNode(
  projectId: string,
  userId: string,
  targetNode: string,
): Promise<MigrationResult> {
  if (!isLocalWorkspace(projectId)) {
    throw new WorkspaceMigrationRequiredError("Восстановление потерянного workspace доступно только в локальном режиме");
  }
  return withMigrationLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project || project.userId !== userId) throw new Error("Проект не найден");
    const meta = await getProjectWorkspaceMeta(projectId);
    if (!meta?.snapshotKey) {
      throw new WorkspaceMigrationRequiredError("У проекта нет snapshot: автоматический перенос после потери ноды невозможен");
    }
    const from = project.node?.trim() || nodeId();
    if (from === targetNode) return {
      projectId,
      from,
      to: targetNode,
      snapshotKey: meta.snapshotKey,
      bytes: meta.workspaceBytes,
      workspaceEpoch: meta.workspaceEpoch,
    };
    await restoreOnTarget(projectId, userId, targetNode);
    const moved = await moveProjectWorkspace(projectId, targetNode, meta.workspaceEpoch);
    console.log("[workspace] проект " + projectId + " восстановлен после потери " + from + " → " + targetNode);
    return {
      projectId,
      from,
      to: targetNode,
      snapshotKey: meta.snapshotKey,
      bytes: meta.workspaceBytes,
      workspaceEpoch: moved.workspaceEpoch,
    };
  });
}

export async function migrateProjectWorkspace(
  projectId: string,
  userId: string,
  targetNode: string,
): Promise<MigrationResult> {
  if (!isLocalWorkspace(projectId)) {
    throw new WorkspaceMigrationRequiredError("Миграция через snapshot доступна только в локальном режиме workspace");
  }
  return withMigrationLock(projectId, async () => {
    const project = await getProject(projectId);
    if (!project || project.userId !== userId) throw new Error("Проект не найден");
    const from = project.node?.trim() || nodeId();
    if (from !== nodeId()) {
      throw new WorkspaceMigrationRequiredError(
        "Миграция должна выполняться на ноде-владельце " + from + ": запрос не был маршрутизирован.",
      );
    }
    if (targetNode === from) return {
      projectId,
      from,
      to: from,
      snapshotKey: project.snapshotKey ?? "",
      bytes: project.workspaceBytes ?? 0,
      workspaceEpoch: Math.max(0, Math.trunc(project.workspaceEpoch ?? 0)),
    };

    const target = await getNode(targetNode);
    if (!target || target.status !== "online") throw new Error("Целевой узел " + targetNode + " недоступен");
    if (target.workspaceMode !== "local") {
      throw new WorkspaceMigrationRequiredError("Целевой узел " + targetNode + " не работает в локальном режиме workspace");
    }
    if (!target.apiAddress.trim()) throw new Error("У целевого узла не задан внутренний API-адрес");
    const url = targetUrl(target.apiAddress);
    if (!url) throw new Error("Некорректный внутренний API-адрес целевого узла");
    const token = internalToken();
    if (token.length < 32) throw new Error("WEBNESTDEV_INTERNAL_TOKEN не задан: миграция невозможна");

    if (await hydratePreview(projectId).catch(() => undefined)) {
      throw new WorkspaceMigrationRequiredError("Сначала остановите предпросмотр проекта");
    }
    if (listSandboxJobs(projectId).length) {
      throw new WorkspaceMigrationRequiredError("Сначала остановите задания проекта");
    }
    if (await isRunActiveAnywhere(projectId).catch(() => true)) {
      throw new WorkspaceMigrationRequiredError("Сначала дождитесь завершения запуска агента");
    }

    const meta = await getProjectWorkspaceMeta(projectId);
    if (!meta) throw new Error("Метаданные проекта не найдены");
    const snapshot = await snapshotProject(projectId, userId);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webnestdev-internal": "1",
        "x-webnestdev-internal-token": token,
      },
      body: JSON.stringify({ projectId, userId }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error("Целевая нода не восстановила snapshot: HTTP " + response.status + " " + text.slice(0, 300));
    }

    const moved = await moveProjectWorkspace(projectId, targetNode, meta.workspaceEpoch);
    console.log(
      "[workspace] проект " + projectId + " перенесён " + from + " → " + targetNode +
        " (snapshot " + snapshot.bytes + " байт, epoch " + moved.workspaceEpoch + ")",
    );
    return {
      projectId,
      from,
      to: targetNode,
      snapshotKey: snapshot.key,
      bytes: snapshot.bytes,
      workspaceEpoch: moved.workspaceEpoch,
    };
  });
}

/** Метаданные для админского ответа без раскрытия путей и токенов. */
export function publicMigrationMeta(meta: ProjectWorkspaceMeta) {
  return {
    projectId: meta.id,
    node: meta.node,
    workspaceMode: meta.workspaceMode,
    workspaceEpoch: meta.workspaceEpoch,
    snapshotKey: meta.snapshotKey,
    snapshotAt: meta.snapshotAt,
    workspaceBytes: meta.workspaceBytes,
  };
}
