import type { SandboxConfig } from "./sandbox-manager.js";
import { dockerExec } from "./preview/docker-exec.js";
import { getPreview, removePreview } from "./preview/preview-store.js";
import { startPreviewContainer } from "./preview/preview-runner.js";

export type { PreviewState } from "./preview/types.js";

export async function startPreview(config: SandboxConfig) {
  const current = getPreview(config.projectId);
  if (current) {
    const status = await previewStatus(config.projectId);
    if (status.running) return status;
  }
  return startPreviewContainer(config);
}

export async function stopPreview(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { stopped: false };
  await dockerExec(["stop", current.containerId]);
  removePreview(projectId);
  return { stopped: true };
}

/**
 * Returns the recent output of the running preview container, so the panel can
 * show the dev-server logs behind the preview.
 */
export async function previewLogs(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { running: false, logs: "" };

  const result = await dockerExec(["logs", "--tail", "300", current.containerId]);
  const logs = [result.stdout, result.stderr]
    .map(value => value.replace(/\r/g, "").trim())
    .filter(Boolean)
    .join("\n");
  if (result.code !== 0 && !logs) throw new Error("Не удалось прочитать логи предпросмотра");
  return { running: true, logs };
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

  const port = current.port;
  if (!port) {
    removePreview(projectId);
    return {
      running: false,
      error: "Контейнер предпросмотра запущен, но порт не назначен",
    };
  }

  const health = await dockerExec([
    "exec",
    current.containerId,
    "node",
    "-e",
    `fetch('http://127.0.0.1:${port}').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))`,
  ]);

  if (health.code !== 0) {
    removePreview(projectId);
    return {
      running: false,
      error: `Контейнер предпросмотра запущен, но веб-сервер не отвечает на порту ${port}`,
    };
  }

  return {
    running: true,
    port,
    host: current.host,
    containerId: current.containerId,
    startedAt: current.startedAt,
  };
}
