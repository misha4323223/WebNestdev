import { countProjectsByNode, listNodes, listProjectsOnNode, type SandboxNode } from "./node-store.js";
import { isNodeFresh, nodeStaleMs } from "./placement.js";
import { sandboxMemoryMb } from "../sandbox/config.js";
import { getPreview } from "../preview/preview-store.js";
import { listSandboxJobs } from "../sandbox/jobs.js";
import { reassignProjectNode } from "../project-store.js";

/**
 * Rebalancing moves a project's pin from a crowded node to a freer one. It is deliberately
 * narrow, because a wrong move costs a user their running preview:
 *
 * - the target must have room for the project *plus a margin*, and must beat the crowded node by
 *   at least that margin — without hysteresis, two equal nodes would trade projects forever;
 * - only projects without a live preview and without a running job move, since those own
 *   containers on the old node;
 * - one project per tick;
 * - a shared workspace is mandatory: without it the files stay on the old machine and the move
 *   would break the project;
 * - off by default (`WEBNESTDEV_REBALANCE_PROJECTS=1` enables it). Placement already sends new
 *   projects to the roomiest node; this only drains projects that landed on a node before it got
 *   busy, or returns them after a bigger machine comes back.
 */
export type RebalancePlan = {
  from: string;
  to: string;
  fromFreeMb: number;
  toFreeMb: number;
};

export function rebalanceEnabled(): boolean {
  return (process.env.WEBNESTDEV_REBALANCE_PROJECTS ?? "").trim() === "1";
}

export function rebalanceMarginMb(): number {
  const raw = Number(process.env.WEBNESTDEV_REBALANCE_MARGIN_MB);
  return Number.isFinite(raw) && raw >= 128 ? Math.round(raw) : 512;
}

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const MIN_INTERVAL_MS = 60_000;

export function rebalanceIntervalMs(): number {
  const raw = Number(process.env.WEBNESTDEV_REBALANCE_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * Pure decision: which node should give a project away, and to whom. Free memory is measured
 * after the project's own requirement, because that is what placement uses; `fromFreeMb` may be
 * negative, which is exactly the "this node has no room" case worth draining.
 */
export function planRebalance(
  nodes: SandboxNode[],
  projectsByNode: Map<string, number>,
  options: { requiredMemoryMb: number; marginMb?: number; now?: number; staleMs?: number },
): RebalancePlan | null {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? nodeStaleMs();
  const required = Math.max(0, Math.round(options.requiredMemoryMb));
  const margin = Math.max(0, Math.round(options.marginMb ?? rebalanceMarginMb()));
  const healthy = nodes
    .filter(node => node.status === "online" && node.memoryTotalMb > 0 && isNodeFresh(node, now, staleMs))
    .map(node => ({
      id: node.id,
      freeAfterProjectMb: Math.max(0, node.memoryTotalMb - node.memoryUsedMb) - required,
      projects: projectsByNode.get(node.id) ?? 0,
    }))
    .sort((left, right) => right.freeAfterProjectMb - left.freeAfterProjectMb || left.id.localeCompare(right.id));
  const target = healthy[0];
  if (!target || target.freeAfterProjectMb < margin) return null;
  const source = healthy
    .filter(item => item.id !== target.id && item.projects > 0)
    .sort((left, right) => left.freeAfterProjectMb - right.freeAfterProjectMb || left.id.localeCompare(right.id))[0];
  if (!source) return null;
  if (target.freeAfterProjectMb - source.freeAfterProjectMb < margin) return null;
  return { from: source.id, to: target.id, fromFreeMb: source.freeAfterProjectMb, toFreeMb: target.freeAfterProjectMb };
}

export type RebalanceResult = RebalancePlan & { projectId: string };

/** One tick. Exported for tests and for an operator who wants a single conservative pass. */
export async function rebalanceOnce(
  log: (message: string) => void = message => console.log("[rebalance] " + message),
): Promise<RebalanceResult | null> {
  if (!rebalanceEnabled()) return null;
  if ((process.env.WEBNESTDEV_SHARED_SANDBOX ?? "").trim() !== "1") return null;
  const [nodes, counts] = await Promise.all([listNodes(), countProjectsByNode()]);
  const plan = planRebalance(nodes, counts, {
    requiredMemoryMb: sandboxMemoryMb(),
    marginMb: rebalanceMarginMb(),
  });
  if (!plan) return null;
  for (const project of await listProjectsOnNode(plan.from, 10)) {
    // A live preview or job owns a container on the old node; changing the pin would orphan it.
    if (getPreview(project.id) || listSandboxJobs(project.id).length) continue;
    const moved = await reassignProjectNode(project.id, project.userId, plan.to);
    if (!moved) continue;
    log(
      "проект " + project.id + " перенесён с " + plan.from + " на " + plan.to +
        " (свободно после проекта: " + plan.fromFreeMb + " → " + plan.toFreeMb + " МБ)",
    );
    return { ...plan, projectId: project.id };
  }
  return null;
}

let timer: NodeJS.Timeout | null = null;

export function startProjectRebalance() {
  if (!rebalanceEnabled() || timer) return;
  timer = setInterval(() => {
    void rebalanceOnce().catch(error => {
      console.warn("[rebalance] проход не удался: " + (error instanceof Error ? error.message : String(error)));
    });
  }, rebalanceIntervalMs());
  timer.unref?.();
}

export function stopProjectRebalance() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Boot log line: operators must see whether projects can move between machines. */
export function describeProjectRebalance(): string {
  if (!rebalanceEnabled()) return "ребалансировка выключена (WEBNESTDEV_REBALANCE_PROJECTS=1 включает)";
  return (
    "ребалансировка каждые " + Math.round(rebalanceIntervalMs() / 1000) + " с, порог " +
    rebalanceMarginMb() + " МБ; проекты с живым preview/job не переносятся"
  );
}
