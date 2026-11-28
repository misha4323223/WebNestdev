import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { functionsPreviewStats, startFunctionsPreviewExecutor, setFunctionsPreviewDepsForTests } from "./functions-preview.js";
import { startStaticPreview, stopAllStaticPreviews, stopStaticPreview } from "./static-preview.js";
import { removePreview } from "./preview-store.js";
import { stopPreview } from "../preview-manager.js";
import { readFunctionManifest } from "../functions/manifest.js";

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

/** Ответ с заданным кодом и телом: так проверяется разбор отказа runtime. */
async function statusServer(status: number, payload: unknown) {
  const app = http.createServer((request, response) => {
    request.resume();
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, { "content-type": "application/json", "content-length": String(body.byteLength) });
    response.end(body);
  });
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  const address = app.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>(resolve => {
      app.closeAllConnections?.();
      app.close(() => resolve());
    }),
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
    // «Плюс»: контейнерный preview запрещён, но функции публикуются — проверять их можно.
    const started = await startStaticPreview(config(root), { allowContainer: false, allowFunctions: true });
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

test("stopPreview stops a static functions executor even when the preview state is already gone", async () => {
  const root = await project();
  const server = await backend();
  let stops = 0;
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async () => ({ version: 1, runtime: "node", functions: [], jobs: [], bytes: 0 }),
    startProcess: async () => {
      const now = Date.now();
      return {
        containerId: "orphan-functions-container",
        host: "127.0.0.1",
        port: server.port,
        ready: true,
        state: { mode: "container", containerId: "orphan-functions-container", projectId: PROJECT_ID, host: "127.0.0.1", port: server.port, startedAt: now, lastUsedAt: now, ready: true, settled: true },
      };
    },
    removeContainer: async () => {
      stops += 1;
      await server.close();
      return true;
    },
  });
  try {
    const started = await startStaticPreview(config(root), { allowContainer: false, allowFunctions: true });
    assert.equal(started.ok, true);
    assert.equal(functionsPreviewStats().active, 1);

    // Так бывает после остановки с другой реплики или после того, как запись снял сборщик:
    // локальный listener и исполнитель функций при этом остаются в этом процессе.
    removePreview(PROJECT_ID);
    await stopPreview(PROJECT_ID);

    assert.equal(stops, 1, "stopPreview обязан погасить локальный исполнитель без записи состояния");
    assert.equal(functionsPreviewStats().active, 0, "слот контейнера функций освобождён");
  } finally {
    setFunctionsPreviewDepsForTests(null);
    await stopAllStaticPreviews();
    await server.close();
    removePreview(PROJECT_ID);
    await rm(root, { recursive: true, force: true });
  }
});

test("without function permission the static preview does not start a function container", async () => {
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
    const started = await startStaticPreview(config(root), { allowContainer: false, allowFunctions: false });
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

test("reload называет причину отказа runtime, а не только код ответа", async () => {
  const root = await project();
  const server = await statusServer(400, { error: "Каталог функций вне сессии предпросмотра" });
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(value => String(value)).join(" ")); };
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async ({ outDir }) => {
      await mkdir(outDir, { recursive: true });
      return { version: 1, runtime: "node", functions: [], jobs: [], bytes: 0 };
    },
    startProcess: async () => {
      const now = Date.now();
      return {
        containerId: "reject-container",
        host: "127.0.0.1",
        port: server.port,
        ready: true,
        state: { mode: "container", containerId: "reject-container", projectId: PROJECT_ID, host: "127.0.0.1", port: server.port, startedAt: now, lastUsedAt: now, ready: true, settled: true },
      };
    },
    removeContainer: async () => true,
  });
  try {
    const manifest = await readFunctionManifest(root);
    assert.ok(manifest);
    if (!manifest) return;
    const result = await startFunctionsPreviewExecutor(config(root), manifest);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(await result.executor.reload(), false);
    const logged = warnings.join("\n");
    assert.match(logged, /HTTP 400/);
    // Причина — из тела ответа runtime: без него в логе был бы только код.
    assert.match(logged, /вне сессии предпросмотра/);
    await result.executor.stop();
  } finally {
    console.warn = original;
    setFunctionsPreviewDepsForTests(null);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("остановка обрывает начатую перезагрузку: без предупреждений и временных каталогов", async () => {
  const root = await project();
  const server = await statusServer(200, { ok: true });
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(value => String(value)).join(" ")); };
  let builds = 0;
  let removed = 0;
  // Резолвер придержанной сборки: объект, а не переменная, иначе TypeScript считает её null.
  const gate: { release?: () => void } = {};
  setFunctionsPreviewDepsForTests({
    ensureDependencies: async () => ({ ok: true, installed: false, log: "" }),
    build: async ({ outDir }) => {
      builds += 1;
      // Вторая сборка — та, что идёт во время перезагрузки: придерживаем её, чтобы остановка
      // пришлась ровно на неё.
      if (builds === 2) await new Promise<void>(resolve => { gate.release = resolve; });
      await mkdir(outDir, { recursive: true });
      return { version: 1, runtime: "node", functions: [], jobs: [], bytes: 0 };
    },
    startProcess: async () => {
      const now = Date.now();
      return {
        containerId: "stop-reload-container",
        host: "127.0.0.1",
        port: server.port,
        ready: true,
        state: { mode: "container", containerId: "stop-reload-container", projectId: PROJECT_ID, host: "127.0.0.1", port: server.port, startedAt: now, lastUsedAt: now, ready: true, settled: true },
      };
    },
    removeContainer: async () => {
      removed += 1;
      return true;
    },
  });
  try {
    const manifest = await readFunctionManifest(root);
    assert.ok(manifest);
    if (!manifest) return;
    const result = await startFunctionsPreviewExecutor(config(root), manifest);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const runtimeDir = result.executor.runtimeDir;

    const reloading = result.executor.reload();
    for (let attempt = 0; attempt < 400 && builds < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(builds, 2, "перезагрузка началась до остановки");

    const stopping = result.executor.stop();
    gate.release?.();
    assert.equal(await reloading, false, "перезагрузка, оборванная остановкой, не считается успешной");
    await stopping;

    assert.equal(removed, 1, "контейнер убирается один раз и после перезагрузки");
    assert.deepEqual(warnings, [], "обрыв из-за остановки не выдаётся за дефект перезагрузки");
    await assert.rejects(stat(runtimeDir), "временный каталог функций удалён");
    assert.equal(functionsPreviewStats().active, 0);
  } finally {
    gate.release?.();
    console.warn = original;
    setFunctionsPreviewDepsForTests(null);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
