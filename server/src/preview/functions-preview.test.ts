import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { functionsPreviewStats, startFunctionsPreviewExecutor, setFunctionsPreviewDepsForTests } from "./functions-preview.js";
import { startStaticPreview, stopAllStaticPreviews, stopStaticPreview } from "./static-preview.js";
import { removePreview } from "./preview-store.js";

const PROJECT_ID = "functions-preview-test";

function config(root: string): SandboxConfig {
  return { projectId: PROJECT_ID, root, memoryMb: 512, cpuLimit: 0.5, timeoutMs: 5000 };
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-functions-preview-"));
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "index.html"), "<html><body>functions preview</body></html>");
  await writeFile(path.join(root, "nestdev.functions.json"), JSON.stringify({
    version: 1,
    runtime: "node",
    functions: [{
      name: "hello",
      path: "/api/hello",
      methods: ["GET"],
      handler: "api/hello.ts#handler",
    }],
    jobs: [],
  }));
  return root;
}

async function backend() {
  const app = http.createServer((request, response) => {
    const body = Buffer.from(JSON.stringify({ ok: true, path: request.url }));
    response.writeHead(200, { "content-type": "application/json", "content-length": String(body.byteLength) });
    response.end(body);
  });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>(resolve => app.close(() => resolve())),
  };
}

test("one executor serves every API request and is stopped with the preview", async () => {
  const root = await project();
  const server = await backend();
  let starts = 0;
  let stops = 0;
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => ({ version: 1, runtime: "node", functions: [], jobs: [], bytes: 0 }),
    startProcess: async () => {
      starts += 1;
      const now = Date.now();
      return {
        containerId: "functions-container",
        host: "127.0.0.1",
        port: server.port,
        ready: true,
        state: {
          mode: "container",
          containerId: "functions-container",
          projectId: PROJECT_ID,
          host: "127.0.0.1",
          port: server.port,
          startedAt: now,
          lastUsedAt: now,
          ready: true,
          settled: true,
        },
      };
    },
    removeContainer: async () => {
      stops += 1;
      await server.close();
      return true;
    },
  });
  try {
    const started = await startStaticPreview(config(root));
    assert.equal(started.ok, true);
    if (!started.ok || !started.status.running) return;
    assert.equal(started.status.mode, "static");
    assert.equal(started.status.ready, true);
    assert.match(started.status.hint ?? "", /один контейнер/i);

    const base = "http://127.0.0.1:" + started.status.port;
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /functions preview/);

    for (let index = 0; index < 2; index += 1) {
      const api = await fetch(base + "/api/hello?request=" + index);
      assert.equal(api.status, 200);
      assert.deepEqual(await api.json(), { ok: true, path: "/api/hello?request=" + index });
    }
    assert.equal(starts, 1, "второй запрос к API не должен запускать новый контейнер");

    await stopStaticPreview(PROJECT_ID);
    assert.equal(stops, 1);
    assert.equal(functionsPreviewStats().active, 0, "остановка освобождает слот контейнера функций");
    await assert.rejects(fetch(base + "/"));
  } finally {
    setFunctionsPreviewDepsForTests(null);
    await stopAllStaticPreviews();
    removePreview(PROJECT_ID);
    await rm(root, { recursive: true, force: true });
  }
});

test("without container permission the static preview does not start a function container", async () => {
  const root = await project();
  let starts = 0;
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    startProcess: async () => {
      starts += 1;
      throw new Error("must not start");
    },
  });
  try {
    const started = await startStaticPreview(config(root), { allowContainer: false });
    assert.equal(started.ok, true);
    if (!started.ok || !started.status.running) return;
    assert.equal(starts, 0);
    const api = await fetch("http://127.0.0.1:" + started.status.port + "/api/hello");
    assert.equal(api.status, 404);
  } finally {
    setFunctionsPreviewDepsForTests(null);
    await stopAllStaticPreviews();
    removePreview(PROJECT_ID);
    await rm(root, { recursive: true, force: true });
  }
});

test("executor rebuilds and reloads without restarting the container", async () => {
  const root = await project();
  let builds = 0;
  let starts = 0;
  let reloads = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/__preview/reload") reloads += 1;
    const body = Buffer.from(JSON.stringify({ ok: true }));
    response.writeHead(200, { "content-type": "application/json", "content-length": String(body.byteLength) });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async ({ outDir }) => {
      builds += 1;
      await mkdir(outDir, { recursive: true });
      return { version: 1, runtime: "node", functions: [], jobs: [], bytes: 0 };
    },
    startProcess: async () => {
      starts += 1;
      const now = Date.now();
      return {
        containerId: "reload-container",
        host: "127.0.0.1",
        port,
        ready: true,
        state: { mode: "container", containerId: "reload-container", projectId: PROJECT_ID, host: "127.0.0.1", port, startedAt: now, lastUsedAt: now, ready: true, settled: true },
      };
    },
    removeContainer: async () => {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      return true;
    },
  });
  try {
    const { readFunctionManifest } = await import("../functions/manifest.js");
    const manifest = await readFunctionManifest(root);
    assert.ok(manifest);
    if (!manifest) return;
    const result = await startFunctionsPreviewExecutor(config(root), manifest);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(builds, 1);
    assert.equal(starts, 1);
    assert.equal(await result.executor.reload(), true);
    assert.equal(builds, 2, "reload пересобирает функции в новую версию");
    assert.equal(reloads, 1, "runtime получает команду перечитать модули");
    assert.equal(starts, 1, "контейнер при reload не перезапускается");
    await result.executor.stop();
  } finally {
    setFunctionsPreviewDepsForTests(null);
    await rm(root, { recursive: true, force: true });
  }
});

test("executor build failure is returned as a preview reason", async () => {
  const root = await project();
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => { throw new Error("esbuild failed"); },
  });
  try {
    const manifest = {
      version: 1 as const,
      runtime: "node" as const,
      functions: [{ name: "hello", path: "/api/hello", methods: ["GET" as const], handler: "api/hello.ts#handler", timeoutMs: 10_000, memoryMb: 256 }],
      jobs: [],
    };
    const result = await startFunctionsPreviewExecutor(config(root), manifest);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /esbuild failed/);
    assert.equal(functionsPreviewStats().active, 0, "неудачная сборка не занимает слот");
  } finally {
    setFunctionsPreviewDepsForTests(null);
    await rm(root, { recursive: true, force: true });
  }
});
