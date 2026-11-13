import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { listPreviewContainerIds, previewLogs, previewStatus, setPreviewStartDepsForTests, startPreviewWithFallback } from "./preview-manager.js";
import { PREVIEW_LABEL, type PreviewStatus } from "./preview/types.js";
import type { SandboxConfig } from "./sandbox-manager.js";
import { getPreview, removePreview, setPreview } from "./preview/preview-store.js";
import { beginPreviewStart, clearPreviewStartProgress, setPreviewStartProgress } from "./preview/preview-start-progress.js";
import type { HybridConfig } from "./preview/hybrid-config.js";

const originalPreviewMode = process.env.PREVIEW_MODE;

afterEach(() => {
  setPreviewStartDepsForTests(null);
  if (originalPreviewMode === undefined) delete process.env.PREVIEW_MODE;
  else process.env.PREVIEW_MODE = originalPreviewMode;
});

const hybridConfig: HybridConfig = {
  buildScript: "build",
  staticDir: "dist",
  backendScript: "start:preview-api",
  backendPaths: ["/api"],
  backendPort: 3000,
  backendEnv: {},
};

const startConfig: SandboxConfig = {
  projectId: "manager-start-test",
  root: "/srv/projects/manager-start-test",
  memoryMb: 512,
  cpuLimit: 0.5,
  timeoutMs: 5_000,
};

const running: PreviewStatus = {
  running: true,
  ready: true,
  host: "127.0.0.1",
  port: 3000,
  containerId: "container-fallback",
  startedAt: 1,
};

/**
 * Подтверждённый адрес — это адрес, на который уже ответил сам сервер, поэтому чтение статуса не должно
 * ходить в контейнер: прокси читает статус на каждый файл приложения, а `docker exec` стоит сотни
 * миллисекунд. До этой проверки каждая загрузка модуля через панель платила лишний раунд, и приложение
 * в панели грузилось заметно медленнее, чем по прямому адресу, которым пользуется Chromium.
 *
 * Замер времени здесь не украшение: без него проверка молча проходила бы и там, где Docker есть, —
 * `docker exec` успел бы отработать и вернуть то же самое.
 */
test("status exposes the current preview start phase before a container exists", async () => {
  const projectId = "manager-progress-test";
  beginPreviewStart(projectId);
  setPreviewStartProgress(projectId, "installing", "Устанавливаем зависимости…", "3 пакета");
  try {
    const status = await previewStatus(projectId);
    assert.equal(status.running, false);
    assert.equal(status.starting?.phase, "installing");
    assert.equal(status.starting?.message, "Устанавливаем зависимости…");
  } finally {
    clearPreviewStartProgress(projectId);
  }
});

test("logs show the start phase while there is no container yet", async () => {
  const projectId = "manager-progress-logs-test";
  beginPreviewStart(projectId);
  setPreviewStartProgress(projectId, "building", "Собираем проект…");
  try {
    const result = await previewLogs(projectId);
    assert.equal(result.running, false);
    assert.match(result.logs, /Собираем проект/);
    assert.equal(result.starting?.phase, "building");
  } finally {
    clearPreviewStartProgress(projectId);
  }
});

test("a confirmed address is served without a container round-trip on every status read", async () => {
  setPreview({ mode: "container", containerId: "c1", projectId: "p1", host: "172.19.0.4", port: 5173, startedAt: 1, lastUsedAt: 1, settled: true });
  try {
    const started = Date.now();
    const status = await previewStatus("p1");
    const elapsed = Date.now() - started;
    assert.deepEqual(status, {
      running: true,
      ready: true,
      settled: true,
      mode: "container",
      port: 5173,
      host: "172.19.0.4",
      containerId: "c1",
      startedAt: 1,
    });
    assert.ok(elapsed < 100, "подтверждённый адрес не должен ждать контейнера: " + elapsed + " мс");
    assert.ok((getPreview("p1")?.lastUsedAt ?? 0) >= 1, "чтение статуса считается использованием — иначе предпросмотр остановит сборщик по бездействию");
  } finally {
    removePreview("p1");
  }
});

/**
 * Без `--no-trunc` Docker отдаёт короткие ID, а общий реестр хранит полный: уборщик не узнавал
 * живой предпросмотр и удалял его при каждом старте API (проверено на node-2 11.11.2026).
 */
test("the reap lists preview containers with full ids", async () => {
  const calls: string[][] = [];
  const ids = await listPreviewContainerIds(async args => {
    calls.push(args);
    return { code: 0, stdout: "abc123\n789def\n" };
  });
  assert.deepEqual(calls[0], ["ps", "-aq", "--no-trunc", "--filter", "label=" + PREVIEW_LABEL]);
  assert.deepEqual(ids, ["abc123", "789def"]);
});

test("a failed container listing reaps nothing", async () => {
  assert.deepEqual(await listPreviewContainerIds(async () => ({ code: 1, stdout: "ignored" })), []);
});

test("a panel status read can skip the use mark", async () => {
  setPreview({ mode: "container", containerId: "c1", projectId: "p-no-touch", host: "172.19.0.4", port: 5173, startedAt: 1, lastUsedAt: 1, settled: true });
  try {
    const status = await previewStatus("p-no-touch", { touch: false });
    assert.equal(status.running, true);
    assert.equal(getPreview("p-no-touch")?.lastUsedAt, 1, "панель не должна продлевать runtime-предпросмотр");
  } finally {
    removePreview("p-no-touch");
  }
});

test("a project without a preview reports nothing running", async () => {
  removePreview("p2");
  assert.deepEqual(await previewStatus("p2"), { running: false });
});

test("auto lets the conservative detector choose hybrid before static", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "auto";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "absent" }),
    detectHybrid: async () => {
      calls.push("detect");
      return { kind: "configured", config: hybridConfig, evidence: ["source src/client.ts содержит /api"], saved: true };
    },
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: true, status: running };
    },
    startStatic: async () => {
      calls.push("static");
      throw new Error("static не должен вызываться после обнаруженного hybrid");
    },
    startContainer: async () => {
      calls.push("container");
      return running;
    },
  });

  const status = await startPreviewWithFallback(startConfig);
  assert.deepEqual(status, running);
  assert.deepEqual(calls, ["detect", "hybrid"]);
});

test("auto reports a hybrid failure without a container fallback by default", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "auto";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "configured", config: hybridConfig }),
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: false, reason: "установка зависимостей не прошла: EAI_AGAIN", failure: "transient" };
    },
    startContainer: async () => {
      calls.push("container");
      return running;
    },
    startStatic: async () => {
      throw new Error("static не должен вызываться после hybrid");
    },
  });

  await assert.rejects(() => startPreviewWithFallback(startConfig), /EAI_AGAIN/);
  assert.deepEqual(calls, ["hybrid"]);
});

test("auto falls back only for an architectural incompatibility", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "auto";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "configured", config: hybridConfig }),
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: false, reason: "backend не ответил", failure: "incompatible" };
    },
    startContainer: async (_config, reason) => {
      calls.push("container:" + reason);
      return running;
    },
  });

  const status = await startPreviewWithFallback(startConfig);
  assert.deepEqual(status, running);
  assert.deepEqual(calls, ["hybrid", "container:hybrid не подошёл: backend не ответил"]);
});

test("fallback none keeps an incompatible hybrid as an error", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "auto";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "configured", config: { ...hybridConfig, fallback: "none" } }),
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: false, reason: "backend не ответил", failure: "incompatible" };
    },
    startContainer: async () => {
      calls.push("container");
      return running;
    },
  });

  await assert.rejects(() => startPreviewWithFallback(startConfig), /backend не ответил/);
  assert.deepEqual(calls, ["hybrid"]);
});

test("a profile can explicitly opt back into the container fallback", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "auto";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "configured", config: { ...hybridConfig, fallback: "container" } }),
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: false, reason: "backend не ответил" };
    },
    startContainer: async (_config, reason) => {
      calls.push("container:" + reason);
      return running;
    },
  });

  const status = await startPreviewWithFallback(startConfig);
  assert.deepEqual(status, running);
  assert.deepEqual(calls, ["hybrid", "container:hybrid не подошёл: backend не ответил"]);
});

test("strict hybrid reports the failure and never falls back to a container", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "hybrid";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "configured", config: hybridConfig }),
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: false, reason: "Нет backend-скрипта" };
    },
    startContainer: async () => {
      calls.push("container");
      return running;
    },
  });

  await assert.rejects(() => startPreviewWithFallback(startConfig), /Нет backend-скрипта/);
  assert.deepEqual(calls, ["hybrid"]);
});

test("explicit container mode skips a configured hybrid without touching it", async () => {
  const calls: string[] = [];
  process.env.PREVIEW_MODE = "container";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "configured", config: hybridConfig }),
    startHybrid: async () => {
      calls.push("hybrid");
      return { ok: false, reason: "must not run" };
    },
    startContainer: async () => {
      calls.push("container");
      return running;
    },
  });

  const status = await startPreviewWithFallback(startConfig);
  assert.deepEqual(status, running);
  assert.deepEqual(calls, ["container"]);
});

test("strict hybrid refuses a project without preview.mode=hybrid", async () => {
  process.env.PREVIEW_MODE = "hybrid";
  setPreviewStartDepsForTests({
    readHybridConfig: async () => ({ kind: "absent" }),
    startContainer: async () => running,
  });

  await assert.rejects(() => startPreviewWithFallback(startConfig), /должен объявить preview\.mode/);
});
