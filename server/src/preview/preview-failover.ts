import { isRunActiveAnywhere } from "../agent/run-activity.js";
import { getProject, reassignProjectNode } from "../project-store.js";
import { readNodePower } from "../nodes/mws-power.js";
import { nodeId } from "../nodes/identity.js";
import {
  listNodes,
  listProjectsOnNode,
  type ProjectOnNode,
  type SandboxNode,
} from "../nodes/node-store.js";
import { chooseProjectNode, isNodeFresh, nodeStaleMs } from "../nodes/placement.js";
import { sandboxMemoryMb } from "../sandbox/config.js";
import { listSandboxJobs } from "../sandbox/jobs.js";
import { clearPreviewSecrets } from "../secrets/preview-secrets.js";
import { clearPreviewReservation } from "./preview-reservation.js";
import {
  flushPreviewWrites,
  hydratePreview,
  listPreviewsAcrossReplicas,
  removePreview,
} from "./preview-store.js";
import type { PreviewState } from "./types.js";

/**
 * Восстановление preview после аварии ноды.
 *
 * Preview — локальный контейнер или слушатель API, поэтому после падения ноды его нельзя
 * «передать» живой реплике: старый экземпляр уже мёртв. Задача этого модуля — убрать его
 * состояние, чтобы проект перестал считаться занятым, и перевесить pin проекта на живую ноду.
 * Следующий запуск preview соберёт его заново из общего workspace.
 *
 * Перенос выполняется только после подтверждённой потери ноды: `status=offline` или
 * `power=OFF` в MWS. Одного устаревшего heartbeat недостаточно: при сетевой изоляции
 * контейнер на «потерянной» ноде может быть жив, и второй preview начал бы писать в тот же
 * каталог. Арбитра пока нет, поэтому MWS-подтверждение — единственная безопасная граница.
 */

export type NodePower = { power: "ON" | "OFF" };
export type NodeLostReason = "offline" | "power-off";

export type NodeLostDeps = {
  now?: () => number;
  staleMs?: number;
  readPower?: (id: string) => Promise<NodePower>;
  /** MWS не должен задерживать запуск preview, если его API завис. */
  powerTimeoutMs?: number;
  log?: (message: string) => void;
};

const powerErrorNotified = new Set<string>();

/**
 * Подтверждена ли потеря ноды. `offline` — явное решение оператора/failover-контроллера;
 * для stale-ноды нужен `power=OFF` из MWS. Ошибка MWS не разрешает перенос: это может быть
 * сетевая изоляция, а не выключенная машина.
 */
export async function nodeLostReason(
  node: SandboxNode,
  deps: NodeLostDeps = {},
): Promise<NodeLostReason | null> {
  if (node.status === "offline") return "offline";
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? nodeStaleMs();
  if (isNodeFresh(node, now, staleMs)) return null;
  try {
    const state = await withTimeout(
      (deps.readPower ?? readNodePower)(node.id),
      deps.powerTimeoutMs ?? 5_000,
    );
    powerErrorNotified.delete(node.id);
    return state.power === "OFF" ? "power-off" : null;
  } catch (error) {
    if (!powerErrorNotified.has(node.id)) {
      powerErrorNotified.add(node.id);
      const message = error instanceof Error ? error.message : String(error);
      const log = deps.log ?? (text => console.warn("[preview-failover] " + text));
      log("не удалось проверить power ноды " + node.id + ": " + message + "; перенос отложен");
    }
    return null;
  }
}

export async function isNodeConfirmedLost(node: SandboxNode, deps: NodeLostDeps = {}) {
  return (await nodeLostReason(node, deps)) !== null;
}

/**
 * Снять состояние preview, не обращаясь к Docker потерянной ноды. `removePreview` убирает
 * локальный кэш и ставит в очередь удаление общей строки; flush нужен до переноса pin, иначе
 * следующий `getSandbox` ещё увидит проект занятым. Бронь и временные env-файлы тоже снимаются:
 * иначе запуск на новой ноде мог бы упереться в старую бронь.
 */
export async function clearLostPreviewState(projectId: string, expectedNode?: string): Promise<boolean> {
  const current = await hydratePreview(projectId);
  if (!current) return false;
  // Legacy-строки без node не могут принадлежать живой ноде: они появились до общего реестра.
  if (expectedNode && current.node && current.node !== expectedNode) return false;
  removePreview(projectId);
  await flushPreviewWrites(projectId);
  try {
    await clearPreviewReservation(projectId);
  } catch (error) {
    console.warn(
      "[preview-failover] не удалось снять бронь " + projectId + ": " + describeError(error),
    );
  }
  try {
    await clearPreviewSecrets(projectId);
  } catch (error) {
    console.warn(
      "[preview-failover] не удалось удалить временные env-файлы " + projectId + ": " +
        describeError(error),
    );
  }
  return true;
}

export type ProjectMoveSkip =
  | "active-job"
  | "active-run"
  | "preview-remains"
  | "no-target"
  | "move-failed";

export type FailoverNodeResult = {
  node: string;
  reason: NodeLostReason;
  clearedPreviews: string[];
  movedProjects: string[];
  skippedProjects: Array<{ projectId: string; reason: ProjectMoveSkip }>;
};

export type FailoverSweepDeps = {
  localNode: () => string;
  listNodes: () => Promise<SandboxNode[]>;
  listProjects: (node: string, limit: number) => Promise<ProjectOnNode[]>;
  listPreviews: () => Promise<PreviewState[]>;
  confirmedLost: (node: SandboxNode) => Promise<NodeLostReason | null>;
  clearPreview: (projectId: string, expectedNode: string) => Promise<boolean>;
  hydrate: (projectId: string) => Promise<PreviewState | undefined>;
  getProject: typeof getProject;
  chooseNode: () => Promise<SandboxNode>;
  reassign: typeof reassignProjectNode;
  hasJobs: (projectId: string) => boolean;
  runActive: (projectId: string) => Promise<boolean>;
  log: (message: string) => void;
};

const MAX_PROJECTS_PER_NODE = 200;

const defaultDeps: FailoverSweepDeps = {
  localNode: nodeId,
  listNodes,
  listProjects: (node, limit) => listProjectsOnNode(node, limit),
  listPreviews: listPreviewsAcrossReplicas,
  confirmedLost: node => nodeLostReason(node),
  clearPreview: clearLostPreviewState,
  hydrate: hydratePreview,
  getProject,
  chooseNode: () => chooseProjectNode({ requiredMemoryMb: sandboxMemoryMb() }),
  reassign: reassignProjectNode,
  hasJobs: projectId => listSandboxJobs(projectId).length > 0,
  runActive: isRunActiveAnywhere,
  log: message => console.log("[preview-failover] " + message),
};

/**
 * Один проход. Возвращает отчёт по затронутым нодам, чтобы тесты и оператор видели, что
 * именно очищено и перенесено. Ошибки одной ноды не должны останавливать остальные.
 */
export async function failoverPreviewCleanupOnce(
  overrides: Partial<FailoverSweepDeps> = {},
): Promise<FailoverNodeResult[]> {
  const deps: FailoverSweepDeps = { ...defaultDeps, ...overrides };
  const local = deps.localNode();
  let nodes: SandboxNode[];
  let previews: PreviewState[];
  try {
    [nodes, previews] = await Promise.all([deps.listNodes(), deps.listPreviews()]);
  } catch (error) {
    deps.log("не удалось прочитать реестр: " + describeError(error));
    return [];
  }

  const results: FailoverNodeResult[] = [];
  for (const node of nodes) {
    if (node.id === local) continue;
    let projects: ProjectOnNode[];
    try {
      projects = await deps.listProjects(node.id, MAX_PROJECTS_PER_NODE);
    } catch (error) {
      deps.log("не удалось прочитать проекты ноды " + node.id + ": " + describeError(error));
      continue;
    }
    const nodePreviews = previews.filter(state => state.node === node.id);
    if (!nodePreviews.length && !projects.length) continue;

    let reason: NodeLostReason | null;
    try {
      reason = await deps.confirmedLost(node);
    } catch (error) {
      deps.log("не удалось подтвердить потерю ноды " + node.id + ": " + describeError(error));
      continue;
    }
    if (!reason) continue;

    const result: FailoverNodeResult = {
      node: node.id,
      reason,
      clearedPreviews: [],
      movedProjects: [],
      skippedProjects: [],
    };

    // Сначала снимаем все preview-состояния. Иначе getSandbox справедливо считает проект
    // занятым и не даёт перенести pin, даже когда нода уже подтверждённо выключена.
    const uniqueProjects = [...new Set(nodePreviews.map(state => state.projectId))];
    for (const projectId of uniqueProjects) {
      try {
        if (await deps.clearPreview(projectId, node.id)) result.clearedPreviews.push(projectId);
      } catch (error) {
        deps.log("не удалось очистить preview " + projectId + ": " + describeError(error));
      }
    }

    let target: SandboxNode | null = null;
    let targetUnavailable = false;
    for (const project of projects) {
      const current = await deps.getProject(project.id).catch(() => null);
      if (!current || current.node !== node.id) continue;
      if (await deps.hydrate(project.id).catch(() => undefined)) {
        result.skippedProjects.push({ projectId: project.id, reason: "preview-remains" });
        continue;
      }
      if (deps.hasJobs(project.id)) {
        result.skippedProjects.push({ projectId: project.id, reason: "active-job" });
        continue;
      }
      if (await deps.runActive(project.id).catch(() => true)) {
        result.skippedProjects.push({ projectId: project.id, reason: "active-run" });
        continue;
      }
      if (!target && !targetUnavailable) {
        try {
          target = await deps.chooseNode();
        } catch (error) {
          targetUnavailable = true;
          deps.log("нет живой ноды для проекта " + project.id + ": " + describeError(error));
        }
      }
      if (!target || target.id === node.id) {
        result.skippedProjects.push({ projectId: project.id, reason: "no-target" });
        continue;
      }
      try {
        const moved = await deps.reassign(project.id, project.userId, target.id);
        if (moved) result.movedProjects.push(project.id);
        else result.skippedProjects.push({ projectId: project.id, reason: "move-failed" });
      } catch (error) {
        deps.log("не удалось перенести проект " + project.id + ": " + describeError(error));
        result.skippedProjects.push({ projectId: project.id, reason: "move-failed" });
      }
    }

    if (result.clearedPreviews.length || result.movedProjects.length) {
      deps.log(
        "нода " + node.id + " (" + reason + "): очищено preview " + result.clearedPreviews.length +
          ", перенесено проектов " + result.movedProjects.length +
          (result.skippedProjects.length ? ", пропущено " + result.skippedProjects.length : ""),
      );
    }
    results.push(result);
  }
  return results;
}

export const DEFAULT_PREVIEW_FAILOVER_SWEEP_MS = 30_000;

export function previewFailoverSweepMs(
  value: string | undefined = process.env.PREVIEW_FAILOVER_SWEEP_MS,
): number {
  if (value?.trim() === "0") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 5_000
    ? Math.floor(parsed)
    : DEFAULT_PREVIEW_FAILOVER_SWEEP_MS;
}

let timer: NodeJS.Timeout | null = null;

export function startPreviewFailoverSweeper(sweepMs = previewFailoverSweepMs()) {
  if (timer || sweepMs <= 0) return;
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void failoverPreviewCleanupOnce()
      .catch(error => console.warn("[preview-failover] проход не удался: " + describeError(error)))
      .finally(() => { running = false; });
  }, Math.max(5_000, sweepMs));
  timer.unref?.();
}

export function stopPreviewFailoverSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function describePreviewFailover() {
  const sweepMs = previewFailoverSweepMs();
  if (sweepMs <= 0) return "автоматическая очистка preview после потери ноды выключена";
  return (
    "автоматическая очистка preview после подтверждённой потери ноды каждые " +
    Math.round(sweepMs / 1000) + " с; без MWS power=OFF или offline не переносит"
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("MWS не ответил за " + Math.round(timeoutMs / 1000) + " с")),
        Math.max(1, timeoutMs),
      );
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
