import { connect as netConnect } from "node:net";
import type { SandboxConfig } from "../sandbox-manager.js";
import { getProject } from "../project-store.js";
import { nodeId } from "../nodes/identity.js";
import { dockerForNode } from "./docker-exec.js";
import { previewAppAnswers } from "./app-http.js";
import { clearPreviewSecrets } from "../secrets/preview-secrets.js";
import { ensureProjectDependencies } from "./dependencies.js";
import { planHybridPreview } from "./hybrid-plan.js";
import { createHybridListener, type HybridListener } from "./hybrid-listener.js";
import { localPreviewOwnerAddress, isLocalPreviewOwner, previewOwnerTarget } from "./preview-owner.js";
import { previewLogsOf, removePreviewContainer, startPreviewProcess, type StartedPreviewProcess } from "./preview-runner.js";
import { flushPreviewWrites, hydratePreview, removePreview, setPreview, touchPreview } from "./preview-store.js";
import { isRuntimePreviewMode, type PreviewState, type PreviewStatus } from "./types.js";
import { stopStaticPreview, staticBuildSetting } from "./static-preview.js";
import { indexFileExists, isStaticBuildFresh } from "./static-plan.js";
import { runStaticBuild, staticBuildLog } from "./static-build.js";
import { clearPreviewReservation, reservePreviewStart } from "./preview-reservation.js";
import { decideRuntimePreviewStart, perUserPreviewLimit, runtimePreviewLimit } from "./preview-limiter.js";
import { listPreviewsAcrossReplicas } from "./preview-store.js";

/**
 * Hybrid lifecycle: build the static frontend, start the backend container, then start a listener
 * in this API process. The listener owns `host`/`port`; the backend container is identified by
 * `containerId` and reached through `backendHost`/`backendPort`.
 *
 * Build and listener are intentionally separate from preview-runner: a backend is not a dev
 * server, and a failed hybrid must never be adoptable as the next container preview.
 */

const HYBRID_HOST = "127.0.0.1";
const MAX_LOG_CHARS = 8_000;

type HybridRun = {
  listener: HybridListener;
  containerId: string;
  backendHost: string;
  backendPort: number;
  containerPort?: number;
  dir: string;
  log: string;
  builtAt: number;
  startedAt: number;
  node?: string;
  config: SandboxConfig;
};

const runs = new Map<string, HybridRun>();

/**
 * Test seam: lifecycle tests must prove the ordering and cleanup without Docker. Production uses
 * the direct functions above; a test can replace only the expensive/runtime boundaries.
 */
export type HybridDeps = {
  plan: typeof planHybridPreview;
  ensureDependencies: typeof ensureProjectDependencies;
  build: typeof runStaticBuild;
  startProcess: typeof startPreviewProcess;
  createListener: typeof createHybridListener;
  ownerReachable: (ownerAddress: string) => Promise<boolean>;
  removeContainer: typeof removePreviewContainer;
  clearSecrets: typeof clearPreviewSecrets;
  stopStatic: typeof stopStaticPreview;
};

const defaultDeps: HybridDeps = {
  plan: planHybridPreview,
  ensureDependencies: ensureProjectDependencies,
  build: runStaticBuild,
  startProcess: startPreviewProcess,
  createListener: createHybridListener,
  ownerReachable: previewDoorReachable,
  removeContainer: removePreviewContainer,
  clearSecrets: clearPreviewSecrets,
  stopStatic: stopStaticPreview,
};

let deps: HybridDeps = defaultDeps;

/** Подмена только для unit-тестов: настоящий Docker и сборка в них не запускаются. */
export function setHybridDepsForTests(overrides: Partial<HybridDeps> | null): void {
  deps = { ...defaultDeps, ...(overrides ?? {}) };
}

export type HybridStartResult = { ok: true; status: PreviewStatus } | { ok: false; reason: string };

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** A cheap liveness probe for a hybrid row owned by another replica. A dead owner (a failed
 * node) must not make every start on the surviving replica return a stale address for the full
 * registry TTL. The door port is enough: if it is closed, start the preview here instead. */
function previewDoorReachable(ownerAddress: string): Promise<boolean> {
  const target = previewOwnerTarget(ownerAddress);
  if (!target) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const socket = netConnect({ host: target.host, port: target.port });
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function trimLog(value: string) {
  return value.length > MAX_LOG_CHARS ? value.slice(-MAX_LOG_CHARS) : value;
}

function statusFor(run: HybridRun, ready = true): PreviewStatus {
  const ownerAddress = localPreviewOwnerAddress();
  return {
    running: true,
    ready,
    settled: ready,
    mode: "hybrid",
    host: HYBRID_HOST,
    port: run.listener.port,
    containerId: run.containerId,
    startedAt: run.startedAt,
    backendHost: run.backendHost,
    backendPort: run.backendPort,
    ...(run.containerPort !== undefined ? { containerPort: run.containerPort } : {}),
    ...(run.node ? { node: run.node } : {}),
    ...(ownerAddress ? { ownerAddress } : {}),
    ...(ready ? {} : { hint: "Backend hybrid-предпросмотра ещё не ответил: смотрите логи предпросмотра." }),
  };
}

async function closeRun(run: HybridRun) {
  await run.listener.close().catch(error => {
    console.warn("[preview] hybrid listener не закрылся: " + describeError(error));
  });
}

async function stopRun(run: HybridRun) {
  await closeRun(run);
  await deps.removeContainer(run.containerId, run.node);
}

/**
 * Stop whatever preview belongs to the project before hybrid takes its slot. This deliberately
 * does not call preview-manager.stopPreview(): manager imports this module, and a runtime cycle
 * would make the start path depend on module evaluation order.
 */
async function stopOtherPreview(projectId: string, preserveReservation = false) {
  if (!preserveReservation) await clearPreviewReservation(projectId);
  const current = await hydratePreview(projectId);
  if (!current) {
    await deps.clearSecrets(projectId);
    return;
  }
  if (current.mode === "static") {
    await deps.stopStatic(projectId);
    removePreview(projectId);
  } else if (current.mode === "hybrid") {
    await stopHybridPreview(projectId, preserveReservation);
  } else {
    await deps.removeContainer(current.containerId, current.node);
    removePreview(projectId);
    await deps.clearSecrets(projectId);
  }
}

async function stopProjectIds(ids: string[]) {
  for (const projectId of ids) await stopOtherPreview(projectId);
}

export async function startHybridPreview(config: SandboxConfig): Promise<HybridStartResult> {
  const current = await hydratePreview(config.projectId);
  const existing = runs.get(config.projectId);
  if (current?.mode === "hybrid" && existing?.listener.app.server.listening) {
    touchPreview(config.projectId);
    return { ok: true, status: statusFor(existing) };
  }
  // A hybrid listener lives in the API process that owns the row. Starting from another replica
  // must not remove that backend or create a second listener: the public door already forwards
  // requests to ownerAddress. The local row is only a leftover when this process is the owner.
  if (current?.mode === "hybrid" && current.ownerAddress && !isLocalPreviewOwner(current.ownerAddress)) {
    // Reuse a live owner, but do not let a row from a failed node block a restart on this one.
    if (await deps.ownerReachable(current.ownerAddress)) {
      const remote = await hybridPreviewStatus(config.projectId);
      if (remote.running) {
        touchPreview(config.projectId);
        return { ok: true, status: remote };
      }
    }
  }

  // A run-map entry without the matching hybrid row is stale (the row was removed, or the process
  // restarted). Stop it before planning: otherwise a later invalid config would leave its listener
  // and backend alive with no state pointing at them.
  if (existing) {
    runs.delete(config.projectId);
    await stopRun(existing);
  }

  const plan = await deps.plan(config);
  if (!plan.ok) return plan;

  const project = await getProject(config.projectId).catch(() => null);
  const userId = config.userId || project?.userId || "";
  const reserved = await reservePreviewStart({
    projectId: config.projectId,
    userId,
    node: config.node,
    perUser: perUserPreviewLimit(),
    hostLimit: runtimePreviewLimit(),
  });
  if (reserved.kind === "busy") return { ok: false, reason: reserved.reason };

  let stopIds: string[];
  if (reserved.kind === "disabled") {
    const shared = (await listPreviewsAcrossReplicas()).filter(state => isRuntimePreviewMode(state.mode));
    const decision = decideRuntimePreviewStart({
      live: await Promise.all(shared.map(async state => ({
        projectId: state.projectId,
        userId: state.ownerUserId || (await getProject(state.projectId).catch(() => null))?.userId || "",
        lastUsedAt: state.lastUsedAt,
        node: state.node,
      }))),
      projectId: config.projectId,
      userId,
      node: config.node ?? nodeId(),
    });
    if (!decision.ok) {
      return { ok: false, reason: decision.reason };
    }
    stopIds = decision.stopProjectId ? [decision.stopProjectId] : [];
  } else {
    stopIds = reserved.stopProjectIds;
  }

  let run: HybridRun | undefined;
  let listener: HybridListener | undefined;
  let started: StartedPreviewProcess | undefined;
  try {
    // Stop the old preview only after this start has its runtime slot. Stopping it before the
    // limit check would destroy a working preview just because another project filled the host.
    // A row without a listener is a leftover from an API restart or a stopped process: its
    // backend must not be reused, because it may run old code and nothing can serve its API.
    if (current) await stopOtherPreview(config.projectId, true);
    await stopProjectIds(stopIds);

    const dependencies = await deps.ensureDependencies(config);
    if (!dependencies.ok) return { ok: false, reason: dependencies.reason };

    const previous = runs.get(config.projectId);
    const builtAt = previous?.builtAt ?? 0;
    const buildSetting = staticBuildSetting();
    const fresh = plan.fresh || (plan.built && await isStaticBuildFresh(config.root, plan.dir, builtAt));
    const needsBuild = buildSetting === "always" || (buildSetting !== "never" && !fresh);
    let log = previous?.log ?? "";
    let marker = previous?.builtAt ?? 0;
    if (needsBuild) {
      const result = await deps.build(config, plan.config.buildScript);
      if (!("ok" in result)) return { ok: false, reason: result.reason };
      if (!result.ok) return { ok: false, reason: staticBuildLog(result, plan.config.buildScript) };
      log = (dependencies.log ? dependencies.log + "\n" : "") + staticBuildLog(result, plan.config.buildScript);
      marker = Date.now();
    }
    if (!(await indexFileExists(plan.dir))) {
      return { ok: false, reason: "Сборка hybrid не создала " + plan.config.staticDir + "/index.html" };
    }

    started = await deps.startProcess(config, {
      command: "npm run " + plan.config.backendScript,
      mode: "hybrid",
      port: plan.config.backendPort,
      persistState: false,
      ensureDependencies: false,
      env: plan.config.backendEnv,
    });
    if (started.state.execOnly) {
      await deps.removeContainer(started.containerId, config.node);
      await deps.clearSecrets(config.projectId);
      return { ok: false, reason: "Backend hybrid доступен только через docker exec: для API и WebSocket нужен прямой адрес." };
    }
    listener = await deps.createListener({
      dir: plan.dir,
      backendHost: started.host,
      backendPort: started.port,
      backendPaths: plan.config.backendPaths,
    });
    const now = Date.now();
    run = {
      listener,
      containerId: started.containerId,
      backendHost: started.host,
      backendPort: started.port,
      ...(started.containerPort !== undefined ? { containerPort: started.containerPort } : {}),
      dir: plan.dir,
      log: trimLog(log),
      builtAt: marker,
      startedAt: now,
      ...(config.node ? { node: config.node } : {}),
      config,
    };
    runs.set(config.projectId, run);
    const ownerAddress = localPreviewOwnerAddress();
    const state: PreviewState = {
      mode: "hybrid",
      containerId: started.containerId,
      host: HYBRID_HOST,
      port: listener.port,
      backendHost: started.host,
      backendPort: started.port,
      ...(started.containerPort !== undefined ? { containerPort: started.containerPort } : {}),
      projectId: config.projectId,
      ownerUserId: userId,
      startedAt: now,
      lastUsedAt: now,
      ready: started.ready,
      settled: started.ready,
      checkedAt: now,
      ...(config.node ? { node: config.node } : {}),
      ...(ownerAddress ? { ownerAddress } : {}),
    };
    setPreview(state);
    await flushPreviewWrites(config.projectId);
    return { ok: true, status: statusFor(run, started.ready) };
  } catch (error) {
    if (run) await closeRun(run);
    else if (listener) await listener.close().catch(() => undefined);
    runs.delete(config.projectId);
    if (started) await deps.removeContainer(started.containerId, config.node);
    removePreview(config.projectId);
    await deps.clearSecrets(config.projectId);
    return { ok: false, reason: "Hybrid-предпросмотр не запустился: " + describeError(error) };
  } finally {
    if (reserved.kind === "acquired") await reserved.reservation.release();
  }
}

export async function stopHybridPreview(projectId: string, preserveReservation = false): Promise<void> {
  const run = runs.get(projectId);
  runs.delete(projectId);
  if (run) await stopRun(run);
  // Only look up a state row when there was no run: with a run, stopRun already removed the
  // backend and a second lookup would issue a duplicate docker rm.
  if (!run) {
    const current = await hydratePreview(projectId);
    if (current?.mode === "hybrid") {
      await deps.removeContainer(current.containerId, current.node);
    }
  }
  removePreview(projectId);
  await deps.clearSecrets(projectId);
  if (!preserveReservation) await clearPreviewReservation(projectId);
}

export async function stopAllHybridPreviews(): Promise<void> {
  for (const projectId of [...runs.keys()]) await stopHybridPreview(projectId);
}

export function hybridPreviewLogs(projectId: string): string {
  const run = runs.get(projectId);
  if (!run) return "";
  const header = "Hybrid-предпросмотр: frontend из " + run.dir + ", backend в контейнере " + run.containerId.slice(0, 12) + ".";
  return run.log ? header + "\n\n" + run.log : header;
}

/**
 * Logs for the panel: the build log is local to the owner process, while backend logs may live on
 * another node. A missing container is reported as an empty log so the manager can clear state.
 */
export async function hybridBackendLogs(projectId: string): Promise<{ logs: string; missing: boolean }> {
  const run = runs.get(projectId);
  if (!run) return { logs: "", missing: false };
  return previewLogsOf(run.containerId, dockerForNode(run.node));
}

export async function refreshHybridPreview(projectId: string): Promise<boolean> {
  const run = runs.get(projectId);
  if (!run) return false;
  const config = run.config;
  await stopHybridPreview(projectId);
  const result = await startHybridPreview(config);
  return result.ok;
}

/**
 * Status for the owner replica. A local listener is the only thing that can serve a hybrid
 * preview; if it is gone, keeping a shared row and a backend container alive would make the door
 * route to a dead address. The next start recreates both.
 */
export async function hybridPreviewStatus(projectId: string): Promise<PreviewStatus> {
  const current = await hydratePreview(projectId);
  if (!current) return { running: false };
  // A run in this process is the owner even when the preview door is disabled and there is no
  // ownerAddress. Without that, the local listener would be treated as remote and its dead
  // backend would never be cleaned up. A row with neither owner nor local run is left alone:
  // only the owning process may decide that a listener is gone.
  const local = Boolean(runs.get(projectId)) || (Boolean(current.ownerAddress) && isLocalPreviewOwner(current.ownerAddress!));
  if (!local) {
    touchPreview(projectId);
    return {
      running: true,
      ready: current.ready !== false,
      settled: Boolean(current.settled),
      mode: "hybrid",
      host: current.host,
      port: current.port,
      containerId: current.containerId,
      startedAt: current.startedAt,
      ...(current.backendHost ? { backendHost: current.backendHost } : {}),
      ...(current.backendPort !== undefined ? { backendPort: current.backendPort } : {}),
      ...(current.containerPort !== undefined ? { containerPort: current.containerPort } : {}),
      ...(current.node ? { node: current.node } : {}),
      ...(current.ownerAddress ? { ownerAddress: current.ownerAddress } : {}),
    };
  }
  const run = runs.get(projectId);
  if (!run || !run.listener.app.server.listening) {
    if (run) await closeRun(run);
    runs.delete(projectId);
    await deps.removeContainer(current.containerId, current.node);
    removePreview(projectId);
    await deps.clearSecrets(projectId);
    return { running: false };
  }
  // A confirmed preview is not inspected on every frontend file; a real proxy failure clears
  // `settled`, just like container previews. Without this the panel would run docker inspect and
  // a backend readiness probe for every asset request.
  if (current.settled) {
    touchPreview(projectId);
    return statusFor(run, current.ready !== false);
  }
  const inspect = await dockerForNode(run.node)([
    "inspect",
    "-f",
    "{{.State.Running}}",
    current.containerId,
  ]).catch(() => null);
  if (!inspect || inspect.code !== 0 || inspect.stdout.trim() !== "true") {
    runs.delete(projectId);
    await closeRun(run);
    await deps.removeContainer(current.containerId, current.node);
    removePreview(projectId);
    await deps.clearSecrets(projectId);
    return { running: false };
  }
  const ready = await previewAppAnswers({
    containerId: current.containerId,
    port: current.backendPort ?? current.port,
    ...(current.containerPort !== undefined ? { containerPort: current.containerPort } : {}),
  }, dockerForNode(run.node));
  // Persist the answer: without this the next status would run the same probe again because the
  // row stayed unsettled, and a recovered backend would never take the fast path.
  setPreview({ ...current, ready, settled: ready, checkedAt: Date.now(), lastUsedAt: Date.now() });
  return statusFor(run, ready);
}
