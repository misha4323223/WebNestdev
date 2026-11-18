import type { SandboxNode } from "./node-store.js";
import { listNodes, countProjectsByNode } from "./node-store.js";
import { ensureLocalNode } from "./local-node.js";

/**
 * Placement is deliberately a pure ranking plus a small storage lookup. A node is eligible only
 * while it is online, fresh, and reports a real memory capacity. A draining or offline node is
 * never a fallback: accepting new projects there would silently undo the drain.
 *
 * Ranking uses free memory first (after reserving the project's sandbox memory), then fewer
 * containers, then fewer projects. This keeps a new project off a node that is already under
 * pressure even when project counts are equal.
 */
export type NodePlacement = {
  node: SandboxNode;
  projectCount: number;
  freeMemoryMb: number;
  /** Free memory left after this project would get its usual sandbox allotment. */
  freeAfterProjectMb: number;
  freeDiskMb: number;
};

export const DEFAULT_NODE_STALE_MS = 2 * 60 * 1000;

export function nodeStaleMs(setting: string | undefined = process.env.WEBNESTDEV_NODE_STALE_MS): number {
  const raw = Number(setting);
  return Number.isFinite(raw) && raw >= 10_000 ? Math.round(raw) : DEFAULT_NODE_STALE_MS;
}

export function isNodeFresh(node: SandboxNode, now = Date.now(), staleMs = nodeStaleMs()): boolean {
  const seen = Date.parse(node.lastSeenAt);
  return Number.isFinite(seen) && now - seen <= staleMs;
}

export function rankNodes(
  nodes: SandboxNode[],
  projectsByNode: Map<string, number>,
  options: { now?: number; staleMs?: number; requiredMemoryMb?: number; requiredDiskMb?: number } = {},
): NodePlacement[] {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? nodeStaleMs();
  const requiredMemoryMb = Math.max(0, Math.round(options.requiredMemoryMb ?? 0));
  const requiredDiskMb = options.requiredDiskMb === undefined
    ? undefined
    : Math.max(0, Math.round(options.requiredDiskMb));
  return nodes
    .filter(node => node.status === "online" && node.memoryTotalMb > 0 && isNodeFresh(node, now, staleMs))
    // Диск проверяется только когда вызывающий явно просит локальный workspace. В shared-режиме
    // старые/внешние узлы без disk-метрик должны оставаться доступными, как раньше.
    .filter(node => requiredDiskMb === undefined || (node.diskTotalMb > 0 && node.diskFreeMb >= requiredDiskMb))
    .map(node => {
      const freeMemoryMb = Math.max(0, node.memoryTotalMb - node.memoryUsedMb);
      return {
        node,
        projectCount: projectsByNode.get(node.id) ?? 0,
        freeMemoryMb,
        freeAfterProjectMb: freeMemoryMb - requiredMemoryMb,
        freeDiskMb: Math.max(0, node.diskFreeMb),
      };
    })
    .sort((left, right) => {
      if (left.freeAfterProjectMb !== right.freeAfterProjectMb) {
        return right.freeAfterProjectMb - left.freeAfterProjectMb;
      }
      if (left.node.containers !== right.node.containers) {
        return left.node.containers - right.node.containers;
      }
      if (left.projectCount !== right.projectCount) return left.projectCount - right.projectCount;
      return left.node.id.localeCompare(right.node.id);
    });
}

/**
 * A healthy node exists, but not one with room for the project. Overfilling a machine is worse
 * than a clear refusal: containers then start and die on the host's own memory limit, and the
 * user sees a broken preview instead of "нет свободной ёмкости".
 */
export class NoCapacityError extends Error {
  readonly statusCode = 503;
  readonly code = "NO_CAPACITY";
  constructor(
    readonly requiredMemoryMb: number,
    readonly freeMemoryMb: number,
    readonly node: string,
  ) {
    super(
      "Нет свободной ёмкости: для проекта нужно " + requiredMemoryMb + " МБ, " +
        "на самом свободном узле (" + node + ") доступно " + freeMemoryMb + " МБ. " +
        "Добавьте узел или освободите память на существующих.",
    );
    this.name = "NoCapacityError";
  }
}

export class NoSandboxNodeError extends Error {
  readonly statusCode = 503;
  readonly code = "NO_SANDBOX_NODE";

  constructor(message = "Нет доступного узла исполнения: все узлы выведены из обслуживания или не отвечают.") {
    super(message);
    this.name = "NoSandboxNodeError";
  }
}

type ChooseNodeDeps = {
  ensureLocal?: () => Promise<SandboxNode>;
  list?: () => Promise<SandboxNode[]>;
  projectsByNode?: () => Promise<Map<string, number>>;
  now?: () => number;
  staleMs?: number;
  requiredMemoryMb?: number;
  requiredDiskMb?: number;
  /**
   * Импорт пишет файлы сразу после создания проекта, поэтому его нельзя создавать на другой ноде:
   * запрос всё равно останется на этой и `getSandbox` откажет с WRONG_WORKSPACE_OWNER.
   */
  requiredNode?: string;
};

/**
 * Pick the node for a new project. `ensureLocalNode` keeps the single-node installation working
 * before the first heartbeat; a remote deployment will have its runner register the same row.
 */
export async function chooseProjectNode(options: ChooseNodeDeps = {}): Promise<SandboxNode> {
  await (options.ensureLocal ?? ensureLocalNode)();
  const [nodes, projectsByNode] = await Promise.all([
    (options.list ?? listNodes)(),
    (options.projectsByNode ?? countProjectsByNode)(),
  ]);
  const ranked = rankNodes(nodes, projectsByNode, {
    ...(options.now ? { now: options.now() } : {}),
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
    ...(options.requiredMemoryMb !== undefined ? { requiredMemoryMb: options.requiredMemoryMb } : {}),
    ...(options.requiredDiskMb !== undefined ? { requiredDiskMb: options.requiredDiskMb } : {}),
  });
  if (!ranked.length) throw new NoSandboxNodeError();
  const required = options.requiredNode
    ? ranked.find(item => item.node.id === options.requiredNode)
    : undefined;
  if (options.requiredNode && !required) {
    throw new NoSandboxNodeError(
      "Узел " + options.requiredNode + " недоступен для нового проекта: выберите другую ноду или дождитесь её возврата",
    );
  }
  const best = required ?? ranked[0];
  // The gate is opt-in through `requiredMemoryMb`, so callers that only rank nodes (tests, the
  // admin view) keep working; every placement path passes the sandbox requirement.
  if (options.requiredMemoryMb !== undefined && best.freeAfterProjectMb < 0) {
    throw new NoCapacityError(Math.round(options.requiredMemoryMb), best.freeMemoryMb, best.node.id);
  }
  return best.node;
}
