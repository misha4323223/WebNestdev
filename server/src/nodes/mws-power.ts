import { mwsRequest } from "../mws/mws-auth.js";

/**
 * Power control for the two HA VMs through the MWS Compute API.
 *
 * This module only turns a VM on. It never promotes PostgreSQL and never changes
 * HAProxy: the systemd start-guard and the failover controller decide whether the
 * booted node may stay primary. Keeping that boundary here is what makes a
 * "raise the machine" button safe to expose to an operator.
 */

export type MwsPowerDeps = {
  request?: typeof mwsRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
};

export type MwsVmState = { power: "ON" | "OFF"; etag: string };

const DEFAULT_VM_NAMES: Record<string, string> = {
  "node-1": "webnestdev",
  "node-2": "node-2",
};
const DEFAULT_PROJECT = "project-pimashin2015";

function projectFromKey(keyId: string | undefined) {
  return /^projects\/([^/]+)\//.exec(keyId ?? "")?.[1] ?? process.env.MWS_PROJECT_ID?.trim() ?? DEFAULT_PROJECT;
}

/** Full MWS path for a node. `MWS_VM_PATHS` is a JSON map for non-default projects. */
export function nodePowerPath(nodeId: string): string {
  let overrides: Record<string, unknown> = {};
  const raw = process.env.MWS_VM_PATHS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>;
    } catch {
      throw new Error("MWS_VM_PATHS должен быть JSON-объектом вида {\"node-2\":\"/compute/...\"}");
    }
  }
  const override = overrides[nodeId];
  if (typeof override === "string" && override.trim()) return validateVmPath(override.trim());

  const vmName = DEFAULT_VM_NAMES[nodeId] ?? nodeId;
  const project = projectFromKey(process.env.MWS_SA_KEY_ID);
  return "/compute/v1/projects/" + encodeURIComponent(project) + "/virtualMachines/" + encodeURIComponent(vmName);
}

function validateVmPath(value: string) {
  if (!value.startsWith("/compute/v1/projects/") || !value.includes("/virtualMachines/") || value.includes("..")) {
    throw new Error("Путь MWS VM должен начинаться с /compute/v1/projects/ и содержать /virtualMachines/");
  }
  return value;
}

function parseVmState(body: unknown): MwsVmState {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = value.status && typeof value.status === "object" ? (value.status as Record<string, unknown>) : {};
  const hardware = status.hardware && typeof status.hardware === "object" ? (status.hardware as Record<string, unknown>) : {};
  const metadata = value.metadata && typeof value.metadata === "object" ? (value.metadata as Record<string, unknown>) : {};
  const power = String(hardware.power ?? "").toUpperCase();
  const etag = typeof metadata.etag === "string" ? metadata.etag : "";
  if (power !== "ON" && power !== "OFF") throw new Error("MWS не вернул status.hardware.power");
  if (!etag) throw new Error("MWS не вернул metadata.etag");
  return { power, etag };
}

async function requestVm(deps: MwsPowerDeps, method: "GET" | "POST", path: string, body?: unknown): Promise<MwsVmState> {
  const request = deps.request ?? mwsRequest;
  const response = await request({ method, path, ...(body === undefined ? {} : { body }) });
  if (!response.ok) {
    const detail = typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {});
    throw new Error("MWS Compute вернул " + response.status + ": " + detail.slice(0, 300));
  }
  return parseVmState(response.body);
}

/** Read the actual VM power without changing anything. */
export async function readNodePower(nodeId: string, deps: MwsPowerDeps = {}): Promise<MwsVmState> {
  return requestVm(deps, "GET", nodePowerPath(nodeId));
}

/**
 * Turn the VM on and wait for MWS to confirm `power=ON`.
 *
 * The caller must not interpret this as "PostgreSQL is ready": a returning old
 * primary is expected to be blocked by `pg_start_guard` and to serve the API
 * through the current primary until an operator performs rejoin.
 */
export async function powerOnNode(nodeId: string, deps: MwsPowerDeps = {}): Promise<MwsVmState> {
  const path = nodePowerPath(nodeId);
  const current = await requestVm(deps, "GET", path);
  if (current.power === "ON") return current;

  const response = await requestVm(deps, "POST", path, {
    metadata: { etag: current.etag },
    spec: { hardware: { power: "ON" } },
  });
  if (response.power === "ON") return response;

  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const timeoutMs = deps.timeoutMs ?? 180_000;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(2_000);
    const state = await requestVm(deps, "GET", path);
    if (state.power === "ON") return state;
  }
  throw new Error("MWS не подтвердил power=ON за " + Math.round(timeoutMs / 1000) + " с");
}
