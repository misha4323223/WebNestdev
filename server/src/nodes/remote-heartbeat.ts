import { createRemoteSandboxHost } from "../sandbox/remote-host.js";
import { getNode, listNodes, updateNodeMetrics, upsertNode } from "./node-store.js";
import { nodeId } from "./identity.js";

/**
 * The API owns the node registry; a runner has no database access by design. The API therefore
 * polls every remote runner's `/v1/status`, writes the observed memory/container counts and
 * refreshes `lastSeenAt`. A failed poll is not written as a fake heartbeat: the node becomes
 * stale on its own after the placement freshness window, which is the same signal used when a
 * machine actually disappears.
 */
const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;

export function remoteHeartbeatIntervalMs(): number {
  const raw = Number(process.env.WEBNESTDEV_RUNNER_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? raw : DEFAULT_INTERVAL_MS;
}

const failures = new Map<string, string>();

/**
 * A runner cannot write the registry (it has no database). For a new machine the operator can
 * either call the admin endpoint or set `WEBNESTDEV_REMOTE_NODES` once; the entries are
 * idempotent and the heartbeat supplies the real capacity. Existing status/createdAt are
 * preserved, so a redeploy does not silently un-drain a node.
 */
export async function registerConfiguredRemoteNodes(): Promise<number> {
  const raw = process.env.WEBNESTDEV_REMOTE_NODES?.trim();
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[nodes] WEBNESTDEV_REMOTE_NODES не JSON: ожидается [{\"id\":\"node-2\",\"address\":\"10.0.0.12:8790\"}]");
    return 0;
  }
  if (!Array.isArray(parsed)) {
    console.warn("[nodes] WEBNESTDEV_REMOTE_NODES должен быть массивом");
    return 0;
  }
  let changed = 0;
  const local = nodeId();
  for (const item of parsed) {
    const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const address = typeof value.address === "string" ? value.address.trim().replace(/\/+$/, "") : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(id) || id === local || !address) {
      console.warn("[nodes] запись WEBNESTDEV_REMOTE_NODES пропущена: нужны уникальные id и address");
      continue;
    }
    const existing = await getNode(id);
    const now = new Date().toISOString();
    await upsertNode({
      id,
      address,
      status: existing?.status ?? "online",
      memoryTotalMb: existing?.memoryTotalMb ?? 0,
      memoryUsedMb: existing?.memoryUsedMb ?? 0,
      containers: existing?.containers ?? 0,
      lastSeenAt: existing?.lastSeenAt ?? now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (!existing || existing.address !== address) changed++;
  }
  return changed;
}

async function pollOnce() {
  const nodes = await listNodes();
  const local = nodeId();
  await Promise.all(nodes.filter(node => node.id !== local && node.address.trim()).map(async node => {
    const token = process.env.WEBNESTDEV_RUNNER_TOKEN?.trim() ?? "";
    if (token.length < 32) {
      if (failures.get(node.id) !== "token") {
        failures.set(node.id, "token");
        console.warn("[nodes] удалённый узел " + node.id + " пропущен: WEBNESTDEV_RUNNER_TOKEN не задан");
      }
      return;
    }
    try {
      const host = createRemoteSandboxHost({ id: node.id, address: node.address, token });
      const status = await host.status();
      if (!status.metrics) throw new Error("runner не вернул метрики");
      const now = new Date().toISOString();
      await updateNodeMetrics({
        id: node.id,
        address: node.address,
        memoryTotalMb: status.metrics.memoryTotalMb,
        memoryUsedMb: status.metrics.memoryUsedMb,
        containers: status.metrics.containers,
        lastSeenAt: now,
        updatedAt: now,
      });
      if (status.workspace && !status.workspace.shared && process.env.WEBNESTDEV_SHARED_SANDBOX === "1") {
        const key = "workspace:" + status.workspace.root;
        if (failures.get(node.id) !== key) {
          failures.set(node.id, key);
          console.warn(
            "[nodes] runner " + node.id + " не подтверждает общий каталог проектов: " +
              status.workspace.root + ". Удалённые проекты будут недоступны, пока SANDBOX_DIR не смонтирован общим.",
          );
        }
      }
      failures.delete(node.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failures.get(node.id) !== message) {
        failures.set(node.id, message);
        console.warn("[nodes] heartbeat runner " + node.id + " не получен: " + message);
      }
    }
  }));
}

let timer: NodeJS.Timeout | null = null;

export function startRemoteNodeHeartbeat() {
  if (timer) return;
  timer = setInterval(() => {
    void pollOnce().catch(error => {
      console.warn("[nodes] опрос удалённых runner'ов не удался: " + (error instanceof Error ? error.message : String(error)));
    });
  }, remoteHeartbeatIntervalMs());
  timer.unref?.();
  void pollOnce().catch(error => {
    console.warn("[nodes] первый опрос runner'ов не удался: " + (error instanceof Error ? error.message : String(error)));
  });
}

export function stopRemoteNodeHeartbeat() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed for the boot log and tests; no secrets and no network call. */
export function describeRemoteHeartbeat() {
  return "опрос runner'ов каждые " + Math.round(remoteHeartbeatIntervalMs() / 1000) + " с";
}
