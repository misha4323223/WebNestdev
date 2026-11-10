import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-preview-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminPreviewResetRoutes } = await import("./admin-preview.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");

const app = Fastify();
const resetCalls: Array<{ projectId: string; nodes: string[] }> = [];
const audited: Array<{ action: string; target?: string; details?: Record<string, unknown> }> = [];
let resetResult = {
  removedContainers: ["container-1"],
  remainingContainers: [] as string[],
  stateRemoved: true,
  reservationCleared: true,
  warnings: [] as string[],
};

await registerAdminPreviewResetRoutes(app, {
  hydrate: async () => ({
    mode: "container",
    containerId: "container-1",
    projectId: "project-a",
    port: 3000,
    host: "172.21.0.4",
    startedAt: 1,
    lastUsedAt: 2,
    node: "node-2",
  }),
  reset: async (projectId, nodes) => {
    resetCalls.push({ projectId, nodes });
    return resetResult;
  },
  audit: async input => {
    audited.push({ action: input.action, target: input.target, details: input.details });
  },
});
await app.ready();

const admin = await createAdmin("preview-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("сброс закрыт без админ-сессии", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/projects/any/preview/reset",
    payload: { confirm: true },
  });
  assert.equal(response.statusCode, 401);
});

test("сброс требует confirm и известный проект", async () => {
  const user = await createUser("preview-owner@example.test", "user-password-123");
  const project = await createProject("Превью", undefined, user.id);

  const denied = await app.inject({
    method: "POST",
    url: "/api/admin/projects/" + project.id + "/preview/reset",
    headers: auth,
    payload: {},
  });
  assert.equal(denied.statusCode, 400);
  assert.equal(denied.json().code, "CONFIRM_REQUIRED");

  const missing = await app.inject({
    method: "POST",
    url: "/api/admin/projects/no-such-project/preview/reset",
    headers: auth,
    payload: { confirm: true },
  });
  assert.equal(missing.statusCode, 404);
});

test("сброс чистит узел проекта и узел состояния, действие попадает в аудит", async () => {
  const user = await createUser("preview-reset@example.test", "user-password-123");
  const project = await createProject("Магазин", undefined, user.id);
  resetCalls.length = 0;
  audited.length = 0;
  resetResult = {
    removedContainers: ["container-1"],
    remainingContainers: [],
    stateRemoved: true,
    reservationCleared: true,
    warnings: [],
  };

  const response = await app.inject({
    method: "POST",
    url: "/api/admin/projects/" + project.id + "/preview/reset",
    headers: auth,
    payload: { confirm: true },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.removedContainers, ["container-1"]);
  assert.equal(body.reservationCleared, true);
  assert.equal(resetCalls.length, 1);
  assert.equal(resetCalls[0]?.projectId, project.id);
  assert.ok(resetCalls[0]?.nodes.includes("node-2"), "узел из состояния должен попасть в сброс");
  assert.deepEqual(audited, [
    {
      action: "admin.preview.reset",
      target: project.id,
      details: {
        removedContainers: 1,
        remainingContainers: 0,
        reservationCleared: true,
        warnings: 0,
      },
    },
  ]);
});
