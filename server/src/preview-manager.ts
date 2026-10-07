import type { SandboxConfig } from "./sandbox-manager.js";
import { dockerExec } from "./preview/docker-exec.js";
import { getPreview, removePreview } from "./preview/preview-store.js";
import { startPreviewContainer } from "./preview/preview-runner.js";

export type { PreviewState } from "./preview/types.js";

export async function startPreview(config: SandboxConfig) {
  const current = getPreview(config.projectId);
  if (current) return current;
  return startPreviewContainer(config);
}

export async function stopPreview(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { stopped: false };
  await dockerExec(["stop", current.containerId]);
  removePreview(projectId);
  return { stopped: true };
}

export async function previewStatus(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { running: false };

  const inspect = await dockerExec([
    "inspect",
    "-f",
    "{{.State.Running}}",
    current.containerId,
  ]);

  if (inspect.code !== 0 || inspect.stdout.trim() !== "true") {
    removePreview(projectId);
    return { running: false };
  }

  return {
    running: true,
    port: current.port,
    host: current.host,
    containerId: current.containerId,
    startedAt: current.startedAt,
  };
}
