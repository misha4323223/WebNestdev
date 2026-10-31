import { memoryStatus } from "../health/host-metrics.js";
import { nodeId } from "../nodes/identity.js";
import { sandboxStatus } from "../docker-sandbox.js";
import { runDockerCli } from "../sandbox/docker/cli.js";
import { sandboxHostRootDir, sandboxRootDir } from "../sandbox/config.js";
import type { RunnerMetrics, RunnerStatus } from "./protocol.js";

/** Same selection rule as the API: never attach a project container to the database network. */
function isDatabaseNetwork(name: string) {
  return /(^|[-_])db$/i.test(name);
}

function preferPreviewNetwork(names: string[]) {
  const safe = names.filter(name => !isDatabaseNetwork(name));
  return safe.find(name => /(^|[-_])preview$/i.test(name)) ?? safe[0] ?? "";
}

async function dockerNetworks() {
  const listed = await runDockerCli(["network", "ls", "--format", "{{.Name}}"], 5_000).catch(() => null);
  if (!listed || listed.code !== 0) return [] as string[];
  return listed.stdout.split("\n").map(value => value.trim()).filter(Boolean);
}

async function previewNetworks() {
  const configured = process.env.PREVIEW_NETWORK?.trim();
  if (configured) return { preview: configured, attach: [configured] };
  const preview = preferPreviewNetwork(await dockerNetworks());
  return { preview, attach: preview ? [preview] : [] };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export async function runnerMetrics(): Promise<RunnerMetrics> {
  const memory = await memoryStatus();
  const total = nonNegative(memory.totalMb);
  const available = memory.availableMb ?? memory.freeMb;
  const used = total > 0 ? Math.max(0, total - nonNegative(available)) : 0;
  let containers = 0;
  try {
    const listed = await runDockerCli(["ps", "-q"], 2_000);
    if (listed.code === 0) containers = listed.stdout.split(/\s+/).filter(Boolean).length;
  } catch {
    // A runner without Docker still answers status: the API reports the node as unavailable
    // without taking down its own process.
  }
  return { memoryTotalMb: total, memoryUsedMb: used, containers };
}

export async function runnerStatus(): Promise<RunnerStatus> {
  const [status, metrics, networks] = await Promise.all([sandboxStatus(), runnerMetrics(), previewNetworks()]);
  return {
    ok: true,
    nodeId: nodeId(),
    ...status,
    metrics,
    workspace: {
      root: sandboxRootDir(),
      hostRoot: sandboxHostRootDir(),
      shared: (process.env.WEBNESTDEV_SHARED_SANDBOX ?? "").trim() === "1",
    },
    previewNetwork: networks.preview,
    previewAttachNetworks: networks.attach,
  };
}
