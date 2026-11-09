import test from "node:test";
import assert from "node:assert/strict";
import { previewFromRow, setPreviewRegistryBackendForTests, type SharedPreviewBackend } from "./preview-registry.js";
import { previewStatus } from "../preview-manager.js";
import {
  flushPreviewWritesForTests,
  hydratePreview,
  listPreviewsAcrossReplicas,
  removePreview,
  setPreview,
} from "./preview-store.js";
import type { PreviewState } from "./types.js";

function memoryBackend() {
  const rows = new Map<string, PreviewState>();
  const backend: SharedPreviewBackend = {
    enabled: () => true,
    async save(state) {
      rows.set(state.projectId, { ...state });
    },
    async remove(projectId) {
      rows.delete(projectId);
    },
    async touch(projectId, lastUsedAt) {
      const row = rows.get(projectId);
      if (row) rows.set(projectId, { ...row, lastUsedAt });
    },
    async get(projectId) {
      return rows.get(projectId) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async prune() {},
  };
  return { backend, rows };
}

function state(projectId: string, overrides: Partial<PreviewState> = {}): PreviewState {
  return {
    mode: "container",
    containerId: "container-1",
    host: "10.0.0.5",
    port: 4000,
    projectId,
    startedAt: 100,
    lastUsedAt: 100,
    ...overrides,
  };
}

test("container-preview сохраняется, static — нет, а удаление убирает строку", async () => {
  const { backend, rows } = memoryBackend();
  setPreviewRegistryBackendForTests(backend);
  try {
    setPreview(state("registry-container", { ownerUserId: "user-1" }));
    setPreview(state("registry-static", { mode: "static", host: "127.0.0.1" }));
    await flushPreviewWritesForTests();

    assert.equal(rows.get("registry-container")?.ownerUserId, "user-1");
    assert.equal(rows.has("registry-static"), false, "слушатель static живёт только в своём процессе");

    removePreview("registry-container");
    await flushPreviewWritesForTests();
    assert.equal(rows.has("registry-container"), false);

    removePreview("registry-static");
    await flushPreviewWritesForTests();
    assert.equal(rows.has("registry-static"), false);
  } finally {
    setPreviewRegistryBackendForTests(null);
  }
});

test("промах локального кэша поднимает preview из общего реестра и объединяет списки", async () => {
  const { backend, rows } = memoryBackend();
  setPreviewRegistryBackendForTests(backend);
  try {
    rows.set("registry-remote", state("registry-remote", { node: "node-2", ownerUserId: "user-2" }));
    const hydrated = await hydratePreview("registry-remote");
    assert.equal(hydrated?.node, "node-2");
    assert.equal(hydrated?.ownerUserId, "user-2");

    setPreview(state("registry-local"));
    const all = await listPreviewsAcrossReplicas();
    assert.deepEqual(all.map(item => item.projectId).sort(), ["registry-local", "registry-remote"]);
  } finally {
    setPreviewRegistryBackendForTests(null);
    removePreview("registry-local");
    removePreview("registry-remote");
    await flushPreviewWritesForTests();
  }
});

test("статус на второй реплике видит preview, поднятый на node-2", async () => {
  const { backend, rows } = memoryBackend();
  setPreviewRegistryBackendForTests(backend);
  try {
    rows.set("registry-status", state("registry-status", {
      node: "node-2",
      ownerUserId: "user-1",
      settled: true,
      host: "10.0.0.5",
      port: 4100,
    }));
    const status = await previewStatus("registry-status");
    assert.equal(status.running, true);
    if (status.running) {
      assert.equal(status.node, "node-2");
      assert.equal(status.port, 4100);
    }
  } finally {
    removePreview("registry-status");
    await flushPreviewWritesForTests();
    setPreviewRegistryBackendForTests(null);
  }
});

test("просроченная или неполная строка не считается живым preview", () => {
  const row = {
    project_id: "p1",
    owner_user_id: "u1",
    node: "node-2",
    mode: "container",
    container_id: "c1",
    host: "10.0.0.5",
    port: 4000,
    container_port: null,
    started_at: 10,
    last_used_at: 20,
    settled: true,
    exec_only: false,
    exec_only_checked_at: null,
    ready: true,
    checked_at: 30,
    expires_at: 1_000,
  };
  assert.equal(previewFromRow(row, 999)?.projectId, "p1");
  assert.equal(previewFromRow(row, 1_000), null, "истёкшая строка не должна выглядеть живой");
  assert.equal(previewFromRow({ ...row, mode: "static" }, 999), null, "static в реестр не пишется");
});
