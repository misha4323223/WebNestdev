import { memoryStatus } from "../health/host-metrics.js";
import { runDockerCli } from "../sandbox/docker/cli.js";
import { nodeAddress, nodeId } from "./identity.js";
import {
  backfillProjectNodes,
  getNode,
  updateNodeMetrics,
  upsertNode,
  type SandboxNode,
} from "./node-store.js";

/**
 * The local node is not special-cased in the registry: it produces the same row a runner will
 * produce later. Memory is read from the host, and the container count is the real number of
 * Docker containers, not a guess from the in-memory preview map (sandbox jobs also consume a
 * slot but are not previews).
 *
 * Docker may be unavailable during a deploy or after a broker restart. That must not prevent
 * the API from starting, so the metric degrades to zero; the next heartbeat corrects it.
 */
export type NodeMetrics = {
  memoryTotalMb: number;
  memoryUsedMb: number;
  containers: number;
};

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export async function localNodeMetrics(): Promise<NodeMetrics> {
  const memory = await memoryStatus();
  const total = nonNegative(memory.totalMb);
  const available = memory.availableMb ?? memory.freeMb;
  const used = total > 0 ? Math.max(0, total - nonNegative(available)) : 0;
  let containers = 0;
  try {
    const listed = await runDockerCli(["ps", "-q"], 2_000);
    if (listed.code === 0) containers = listed.stdout.split(/\s+/).filter(Boolean).length;
  } catch {
    // Docker is an execution dependency, not a prerequisite for serving the API.
  }
  return { memoryTotalMb: total, memoryUsedMb: used, containers };
}

let registration: Promise<SandboxNode> | null = null;

async function registerLocalNode(): Promise<SandboxNode> {
  const id = nodeId();
  const existing = await getNode(id);
  const metrics = await localNodeMetrics();
  const now = new Date().toISOString();
  return upsertNode({
    id,
    address: nodeAddress(),
    // A restart must not silently undo an operator's drain or offline decision.
    status: existing?.status ?? "online",
    ...metrics,
    lastSeenAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

/**
 * Idempotent registration used both at boot and before placement. The existing row is checked
 * every time: in tests and during recovery a data directory can be replaced while this process
 * is alive, and a cached object would then point at a node row that no longer exists.
 */
export async function ensureLocalNode(): Promise<SandboxNode> {
  const existing = await getNode(nodeId());
  if (existing) {
    // The process can place a project, so the node is alive even if a test or a paused event
    // loop means the periodic heartbeat has not run for a while. Keep metrics and status; a
    // status update must be a separate operation so a concurrent drain is never overwritten.
    const now = new Date().toISOString();
    const touched = await updateNodeMetrics({
      ...existing,
      address: nodeAddress(),
      lastSeenAt: now,
      updatedAt: now,
    });
    if (touched) return touched;
  }
  if (registration) {
    const pending = await registration.catch(() => null);
    const created = pending ? await getNode(nodeId()) : null;
    if (created) return created;
    registration = null;
  }
  const pending = registerLocalNode();
  registration = pending;
  try {
    return await pending;
  } finally {
    if (registration === pending) registration = null;
  }
}

/**
 * Refresh only the observed metrics. Status is intentionally preserved: a heartbeat from a
 * draining node must not make it eligible again.
 */
export async function heartbeatLocalNode(): Promise<SandboxNode> {
  const existing = await getNode(nodeId());
  if (!existing) return ensureLocalNode();
  const metrics = await localNodeMetrics();
  const now = new Date().toISOString();
  return (await updateNodeMetrics({
    ...existing,
    address: nodeAddress(),
    ...metrics,
    lastSeenAt: now,
    updatedAt: now,
  })) ?? ensureLocalNode();
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const MIN_HEARTBEAT_MS = 5_000;

export function nodeHeartbeatIntervalMs(): number {
  const raw = Number(process.env.WEBNESTDEV_NODE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= MIN_HEARTBEAT_MS ? raw : DEFAULT_HEARTBEAT_MS;
}

let heartbeatTimer: NodeJS.Timeout | null = null;

export function startNodeHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    void heartbeatLocalNode().catch(error => {
      console.warn("[nodes] heartbeat не записан: " + (error instanceof Error ? error.message : String(error)));
    });
  }, nodeHeartbeatIntervalMs());
  heartbeatTimer.unref?.();
}

export function stopNodeHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * Boot sequence: make sure the local node exists before any project can be created, then
 * backfill old rows whose projects predate node pinning. The heartbeat keeps the observed
 * capacity current for the placement decision.
 */
export async function initializeNodeRegistry(): Promise<{ node: SandboxNode; backfilledProjects: number }> {
  const node = await ensureLocalNode();
  const backfilledProjects = await backfillProjectNodes(node.id);
  startNodeHeartbeat();
  return { node, backfilledProjects };
}
