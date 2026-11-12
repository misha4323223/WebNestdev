import test from "node:test";
import assert from "node:assert/strict";
import { previewFromRow } from "./preview-registry.js";

const base = {
  project_id: "hybrid-project",
  owner_user_id: "user-1",
  node: "node-1",
  mode: "hybrid",
  container_id: "backend-container",
  host: "127.0.0.1",
  port: 4010,
  container_port: 3000,
  backend_host: "172.20.0.4",
  backend_port: 3000,
  started_at: 100,
  last_used_at: 110,
  settled: true,
  exec_only: false,
  exec_only_checked_at: null,
  ready: true,
  checked_at: 120,
  owner_address: "10.0.0.5:8788",
  expires_at: Date.now() + 60_000,
};

test("a complete hybrid row is restored with listener and backend fields", () => {
  const state = previewFromRow(base);
  assert.ok(state);
  assert.equal(state?.mode, "hybrid");
  assert.equal(state?.host, "127.0.0.1");
  assert.equal(state?.port, 4010);
  assert.equal(state?.containerId, "backend-container");
  assert.equal(state?.backendHost, "172.20.0.4");
  assert.equal(state?.backendPort, 3000);
  assert.equal(state?.ownerAddress, "10.0.0.5:8788");
});

test("a hybrid row without a backend address is not treated as a live preview", () => {
  assert.equal(previewFromRow({ ...base, backend_host: "" }), null);
  assert.equal(previewFromRow({ ...base, backend_port: null }), null);
});

test("an expired hybrid row is discarded", () => {
  assert.equal(previewFromRow({ ...base, expires_at: 1 }), null);
});
