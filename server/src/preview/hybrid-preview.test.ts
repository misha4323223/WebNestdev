import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { SandboxConfig } from "../sandbox-manager.js";
import { setHybridDepsForTests, startHybridPreview, stopHybridPreview } from "./hybrid-preview.js";
import { setPreviewReservationBackendForTests } from "./preview-reservation.js";
import { getPreview, removePreview, setPreview } from "./preview-store.js";
import { flushPreviewWritesForTests } from "./preview-store.js";
import { previewStatus } from "../preview-manager.js";
import type { HybridConfig } from "./hybrid-config.js";
import type { PreviewState } from "./types.js";

const PROJECT_ID = "hybrid-lifecycle";

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hybrid-lifecycle-"));
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/index.html"), "<html>hybrid</html>");
  return root;
}

function config(root: string): SandboxConfig {
  return { projectId: PROJECT_ID, root, memoryMb: 512, cpuLimit: 0.5, timeoutMs: 5_000, userId: "user-1" };
}

const hybridConfig: HybridConfig = {
  buildScript: "build",
  staticDir: "dist",
  backendScript: "start:preview-api",
  backendPaths: ["/api", "/ws"],
  backendPort: 3000,
  backendEnv: { NODE_ENV: "production" },
};

afterEach(async () => {
  // Each test must start with no listener from the previous one, even when it used fake deps.
  await stopHybridPreview(PROJECT_ID).catch(() => undefined);
  setHybridDepsForTests(null);
  setPreviewReservationBackendForTests(null);
  removePreview(PROJECT_ID);
  await flushPreviewWritesForTests();
});

test("hybrid starts a listener after its backend and stops both on request", async () => {
  const root = await project();
  const events: string[] = [];
  const listenerClose = async () => { events.push("listener-close"); };
  const state: PreviewState = {
    mode: "container",
    containerId: "backend-1",
    host: "127.0.0.1",
    port: 3000,
    projectId: PROJECT_ID,
    startedAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  let listenerOptions: { dir: string; backendHost: string; backendPort: number; backendPaths: string[] } | undefined;

  setHybridDepsForTests({
    plan: async () => ({
      ok: true,
      config: hybridConfig,
      dir: path.join(root, "dist"),
      built: true,
      build: true,
      fresh: true,
    }),
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => { throw new Error("build must not run for a fresh output"); },
    startProcess: async (_config, options) => {
      events.push("backend:" + options.mode);
      return {
        containerId: "backend-1",
        host: "127.0.0.1",
        port: 3000,
        containerPort: 3000,
        ready: true,
        state,
      };
    },
    createListener: async options => {
      listenerOptions = options;
      events.push("listener-start");
      return {
        app: { server: { listening: true } } as unknown as FastifyInstance,
        port: 4123,
        close: listenerClose,
      };
    },
    removeContainer: async () => { events.push("backend-remove"); return true; },
    clearSecrets: async () => undefined,
    stopStatic: async () => undefined,
  });

  try {
    const started = await startHybridPreview(config(root));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.status.running, true);
    if (!started.status.running) return;
    assert.equal(started.status.mode, "hybrid");
    assert.equal(started.status.port, 4123);
    assert.equal(started.status.backendHost, "127.0.0.1");
    assert.equal(started.status.backendPort, 3000);
    assert.equal(listenerOptions?.dir, path.join(root, "dist"));
    assert.deepEqual(listenerOptions?.backendPaths, ["/api", "/ws"]);
    assert.deepEqual(events, ["backend:hybrid", "listener-start"]);
    assert.equal(getPreview(PROJECT_ID)?.mode, "hybrid");

    // The browser check may arrive after the row was lost while the listener is still alive.
    // Recovering it must not require another start or another backend.
    removePreview(PROJECT_ID);
    assert.equal(getPreview(PROJECT_ID), undefined);
    const recovered = await previewStatus(PROJECT_ID);
    assert.equal(recovered.running, true);
    if (recovered.running) assert.equal(recovered.mode, "hybrid");

    await stopHybridPreview(PROJECT_ID);
    assert.deepEqual(events, ["backend:hybrid", "listener-start", "listener-close", "backend-remove"]);
    assert.equal(getPreview(PROJECT_ID), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restarting the same project keeps the reservation it just acquired", async () => {
  const root = await project();
  const events: string[] = [];
  setPreview({
    mode: "hybrid",
    containerId: "old-backend",
    host: "127.0.0.1",
    port: 4001,
    backendHost: "127.0.0.1",
    backendPort: 3000,
    projectId: PROJECT_ID,
    startedAt: 1,
    lastUsedAt: 1,
  });
  setPreviewReservationBackendForTests({
    enabled: () => true,
    reserve: async () => ({ kind: "acquired", reservationId: "reservation-1", stopProjectIds: [] }),
    release: async () => { events.push("release"); },
    clear: async () => { events.push("clear"); },
  });
  setHybridDepsForTests({
    plan: async () => ({
      ok: true,
      config: hybridConfig,
      dir: path.join(root, "dist"),
      built: true,
      build: true,
      fresh: true,
    }),
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => { throw new Error("build must not run"); },
    startProcess: async () => ({
      containerId: "new-backend",
      host: "127.0.0.1",
      port: 3000,
      ready: true,
      state: {
        mode: "container",
        containerId: "new-backend",
        host: "127.0.0.1",
        port: 3000,
        projectId: PROJECT_ID,
        startedAt: 2,
        lastUsedAt: 2,
      },
    }),
    createListener: async () => ({
      app: { server: { listening: true } } as unknown as FastifyInstance,
      port: 4002,
      close: async () => undefined,
    }),
    removeContainer: async () => { events.push("remove"); return true; },
    clearSecrets: async () => undefined,
    stopStatic: async () => undefined,
  });

  try {
    const started = await startHybridPreview(config(root));
    assert.equal(started.ok, true);
    assert.equal(getPreview(PROJECT_ID)?.containerId, "new-backend");
    assert.deepEqual(events, ["remove", "release"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starting on another replica reuses a remotely owned hybrid preview instead of removing its backend", async () => {
  const root = await project();
  setHybridDepsForTests({ ownerReachable: async () => true });
  setPreview({
    mode: "hybrid",
    containerId: "remote-backend",
    host: "127.0.0.1",
    port: 4123,
    backendHost: "10.0.0.5",
    backendPort: 3000,
    projectId: PROJECT_ID,
    startedAt: 10,
    lastUsedAt: 10,
    ready: true,
    settled: true,
    ownerAddress: "203.0.113.10:8788",
  });
  try {
    const started = await startHybridPreview(config(root));
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.status.running, true);
    if (started.status.running) assert.equal(started.status.mode, "hybrid");
    assert.equal(getPreview(PROJECT_ID)?.containerId, "remote-backend");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead remote owner does not block a hybrid start on this replica", async () => {
  const root = await project();
  const events: string[] = [];
  setPreview({
    mode: "hybrid",
    containerId: "dead-backend",
    host: "127.0.0.1",
    port: 4123,
    backendHost: "10.0.0.5",
    backendPort: 3000,
    projectId: PROJECT_ID,
    startedAt: 10,
    lastUsedAt: 10,
    ready: true,
    settled: true,
    ownerAddress: "203.0.113.10:8788",
  });
  setHybridDepsForTests({
    ownerReachable: async () => false,
    plan: async () => ({
      ok: true,
      config: hybridConfig,
      dir: path.join(root, "dist"),
      built: true,
      build: true,
      fresh: true,
    }),
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => { throw new Error("build must not run"); },
    startProcess: async () => ({
      containerId: "recovered-backend",
      host: "127.0.0.1",
      port: 3000,
      ready: true,
      state: {
        mode: "container",
        containerId: "recovered-backend",
        host: "127.0.0.1",
        port: 3000,
        projectId: PROJECT_ID,
        startedAt: 2,
        lastUsedAt: 2,
      },
    }),
    createListener: async () => ({
      app: { server: { listening: true } } as unknown as FastifyInstance,
      port: 4124,
      close: async () => undefined,
    }),
    removeContainer: async () => { events.push("remove"); return true; },
    clearSecrets: async () => undefined,
    stopStatic: async () => undefined,
  });

  try {
    const started = await startHybridPreview(config(root));
    assert.equal(started.ok, true);
    assert.equal(getPreview(PROJECT_ID)?.containerId, "recovered-backend");
    assert.deepEqual(events, ["remove"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manager status on another replica reads a hybrid row without touching its listener", async () => {
  setPreview({
    mode: "hybrid",
    containerId: "remote-backend",
    host: "127.0.0.1",
    port: 4123,
    backendHost: "10.0.0.5",
    backendPort: 3000,
    projectId: "hybrid-remote-status",
    startedAt: 10,
    lastUsedAt: 10,
    ready: true,
    settled: true,
    ownerAddress: "203.0.113.10:8788",
  });
  try {
    const status = await previewStatus("hybrid-remote-status");
    assert.equal(status.running, true);
    if (!status.running) return;
    assert.equal(status.mode, "hybrid");
    assert.equal(status.host, "127.0.0.1");
    assert.equal(status.port, 4123);
    assert.equal(status.backendHost, "10.0.0.5");
    assert.equal(status.backendPort, 3000);
  } finally {
    removePreview("hybrid-remote-status");
    await flushPreviewWritesForTests();
  }
});

test("a listener failure removes the backend and leaves no hybrid state", async () => {
  const root = await project();
  const events: string[] = [];
  setHybridDepsForTests({
    plan: async () => ({
      ok: true,
      config: hybridConfig,
      dir: path.join(root, "dist"),
      built: true,
      build: true,
      fresh: true,
    }),
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => { throw new Error("build must not run"); },
    startProcess: async () => ({
      containerId: "backend-listener-fail",
      host: "127.0.0.1",
      port: 3000,
      ready: true,
      state: {
        mode: "container",
        containerId: "backend-listener-fail",
        host: "127.0.0.1",
        port: 3000,
        projectId: PROJECT_ID,
        startedAt: 1,
        lastUsedAt: 1,
      },
    }),
    createListener: async () => { throw new Error("listener refuse"); },
    removeContainer: async () => { events.push("backend-remove"); return true; },
    clearSecrets: async () => { events.push("secrets-clear"); },
    stopStatic: async () => undefined,
  });

  try {
    const started = await startHybridPreview(config(root));
    assert.equal(started.ok, false);
    if (!started.ok) assert.match(started.reason, /listener refuse/);
    assert.equal(getPreview(PROJECT_ID), undefined);
    assert.deepEqual(events, ["backend-remove", "secrets-clear"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a backend that only answers through docker exec is refused instead of starting a broken listener", async () => {
  const root = await project();
  let listenerStarted = false;
  setHybridDepsForTests({
    plan: async () => ({
      ok: true,
      config: hybridConfig,
      dir: path.join(root, "dist"),
      built: true,
      build: true,
      fresh: true,
    }),
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => { throw new Error("build must not run"); },
    startProcess: async () => ({
      containerId: "backend-exec-only",
      host: "127.0.0.1",
      port: 3000,
      ready: true,
      state: {
        mode: "container",
        containerId: "backend-exec-only",
        host: "127.0.0.1",
        port: 3000,
        projectId: PROJECT_ID,
        startedAt: 1,
        lastUsedAt: 1,
        execOnly: true,
      },
    }),
    createListener: async () => {
      listenerStarted = true;
      throw new Error("must not be reached");
    },
    removeContainer: async () => true,
    clearSecrets: async () => undefined,
    stopStatic: async () => undefined,
  });

  try {
    const started = await startHybridPreview(config(root));
    assert.equal(started.ok, false);
    if (!started.ok) assert.match(started.reason, /docker exec/);
    assert.equal(listenerStarted, false);
    assert.equal(getPreview(PROJECT_ID), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
