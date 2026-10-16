import type { SandboxConfig } from "./sandbox-manager.js";
import { getProject } from "./project-store.js";
import { dockerExec } from "./preview/docker-exec.js";
import { decideRuntimePreviewStart, liveRuntimePreviews } from "./preview/preview-limiter.js";
import { previewAppAnswers } from "./preview/app-http.js";
import { settlePreviewAddress } from "./preview/preview-address.js";
import { getPreview, removePreview, setPreview, touchPreview } from "./preview/preview-store.js";
import { recentPreviewLogs, startPreviewContainer } from "./preview/preview-runner.js";
import { previewModeSetting, startStaticPreview, staticAppAnswers, staticPreviewLogs, stopStaticPreview } from "./preview/static-preview.js";
import { PREVIEW_LABEL, type PreviewStatus } from "./preview/types.js";

export type { PreviewState, PreviewStatus } from "./preview/types.js";

/**
 * Starts the preview the way the panel's button and the agent's verification do. The mode is
 * decided here: `static` builds the project and serves the output from the server process
 * (no container, no memory), `container` is the dev server with live reload, and `auto` — the
 * default — serves the build when the project has one and falls back to the dev server when
 * it does not (no build script, a failing build, or an output without index.html).
 */
export async function startPreview(config: SandboxConfig) {
  try {
    return await startPreviewWithFallback(config);
  } catch (error) {
    // Причина отказа раньше жила только в ответе панели и в сообщении агенту, а тот, кто смотрит
    // логи контейнера сервера (`docker compose logs webnestdev-server`), видел один факт запуска
    // и не мог отличить отсутствующие зависимости от недоступного Docker.
    console.error("[preview] не удалось запустить предпросмотр: проект " + config.projectId + " — " + describeError(error));
    throw error;
  }
}

async function startPreviewWithFallback(config: SandboxConfig) {
  const setting = previewModeSetting();
  if (setting !== "container") {
    const result = await startStaticPreview(config);
    if (result.ok) return result.status;
    // A host that requires static previews must not silently start a container, so the reason
    // is the answer there; every other mode falls back and carries the reason as a hint.
    if (setting === "static") throw new Error(result.reason);
    // Почему проект не удалось отдать статикой — тоже в лог: на маленькой ВМ поднятый контейнер
    // предпросмотра иначе выглядит случайностью, а не следствием непригодной сборки.
    console.log("[preview] проект " + config.projectId + ": статическая сборка не подошла (" + result.reason + ") — поднимаю dev-сервер");
    return startContainerPreview(config, result.reason);
  }
  return startContainerPreview(config);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The dev-server preview. A running one is reused instead of restarted: the dev server
 * watches the project files itself, so the agent's edits appear without another start.
 */
async function startContainerPreview(config: SandboxConfig, staticReason?: string) {
  const current = getPreview(config.projectId);
  if (current?.mode === "static") {
    // The mode changed, or the static start fell back: a listener must not be left behind.
    await stopStaticPreview(config.projectId);
    removePreview(config.projectId);
  } else if (current) {
    const status = await previewStatus(config.projectId);
    if (status.running) return status;
  }
  // A running dev server holds its memory until it is stopped, so this is the one preview kind
  // that has to be counted. A static preview is not: it is a listener, and the panel shows it
  // from the same process whatever this number says.
  const project = await getProject(config.projectId);
  const live = await Promise.all(
    liveRuntimePreviews().map(async state => ({
      projectId: state.projectId,
      lastUsedAt: state.lastUsedAt,
      userId: (await getProject(state.projectId))?.userId,
    })),
  );
  const decision = decideRuntimePreviewStart({ live, projectId: config.projectId, userId: project?.userId ?? "" });
  if (!decision.ok) throw new Error(decision.reason);
  if (decision.stopProjectId) await stopPreview(decision.stopProjectId);
  const status = await startPreviewContainer(config);
  if (!staticReason || !status.ready) return status;
  return { ...status, hint: "Статическая сборка недоступна (" + staticReason + "), работает dev-сервер." };
}

export async function stopPreview(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { stopped: false };
  if (current.mode === "static") {
    await stopStaticPreview(projectId);
    removePreview(projectId);
    return { stopped: true };
  }
  await dockerExec(["stop", current.containerId]);
  removePreview(projectId);
  return { stopped: true };
}

/**
 * Returns what the panel shows behind the preview: the dev-server output for a container
 * preview, the build output for a static one (nothing runs that could produce more).
 */
export async function previewLogs(projectId: string) {
  const current = getPreview(projectId);
  if (!current) return { running: false, logs: "" };

  if (current.mode === "static") {
    // Somebody is reading the logs, so the preview is in use.
    touchPreview(projectId);
    return { running: true, logs: staticPreviewLogs(projectId) };
  }

  const logs = await recentPreviewLogs(current.containerId);
  // Somebody is reading the logs, so the preview is in use.
  touchPreview(projectId);
  return { running: true, logs };
}

/**
 * The preview state lives in memory, so after a server restart every labelled preview
 * container is an orphan: nothing owns it, it keeps running with its resources, and the
 * next start would create a second one for the same project. Reaping on boot keeps that
 * bounded. Set PREVIEW_REAP_ON_START=0 when several server replicas share one Docker host.
 * Static previews live in this process, so a restart leaves nothing of them behind.
 */
export async function reapOrphanPreviews() {
  if (process.env.PREVIEW_REAP_ON_START === "0") return { stopped: 0 };
  const listed = await dockerExec(["ps", "-q", "--filter", "label=" + PREVIEW_LABEL]);
  const ids = listed.stdout.split("\n").map(value => value.trim()).filter(Boolean);
  for (const id of ids) await dockerExec(["stop", id], 30000);
  return { stopped: ids.length };
}

export async function previewStatus(projectId: string): Promise<PreviewStatus> {
  const current = getPreview(projectId);
  if (!current) return { running: false };

  // Nothing runs in a container for a static preview, so there is nothing to inspect: the
  // listener answers or it does not.
  if (current.mode === "static") {
    const ready = await staticAppAnswers(current.host, current.port);
    touchPreview(projectId);
    return {
      running: true,
      ready,
      mode: "static",
      port: current.port,
      host: current.host,
      containerId: current.containerId,
      startedAt: current.startedAt,
      ...(ready
        ? {}
        : { hint: "Статическая сборка не отвечает — запустите предпросмотр заново." }),
    };
  }

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

  // Every status read counts as use: the panel refreshes it, the logs tab polls it and the
  // agent's project.verify/browser.* checks go through it, as does every proxied request.
  touchPreview(projectId);

  // A dev server that is still compiling has not failed: the container is the truth here,
  // and `ready` says whether the app answers yet. Dropping the state on a slow first start
  // used to lose the container and leave it running with nothing left to stop it.
  const ready = await previewAppAnswers(current);
  // Приложение отвечает внутри контейнера, но не по адресу контейнера (обычно слушает только
  // петлю, а иногда — свой порт вместо запрошенного): адрес доводится до рабочего здесь же,
  // потому что статус читают и панель, и прокси, и агент. Медленный первый старт поэтому
  // лечится сам, без перезапуска предпросмотра вручную.
  const settled = ready ? await settlePreviewAddress(current, { appAnswers: true }) : current;
  if (settled !== current) setPreview(settled);

  return {
    running: true,
    ready,
    mode: "container",
    port: settled.port,
    host: settled.host,
    containerId: current.containerId,
    startedAt: current.startedAt,
    ...(ready
      ? {}
      : { hint: "Приложение ещё запускается: первый старт dev-сервера занимает несколько секунд." }),
  };
}
