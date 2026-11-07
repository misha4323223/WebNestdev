import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "local";
process.env.WEBNESTDEV_SHARED_SANDBOX = "1";
const root = await mkdtemp(path.join(tmpdir(), "admin-project-node-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminNodeRoutes } = await import("./admin-nodes.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { upsertNode } = await import("../nodes/node-store.js");
const { createProject, getProject } = await import("../project-store.js");
const { ZodError } = await import("zod");

const admin = await createAdmin("move-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };
const app = Fastify();
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: "Некорректный запрос" });
  return reply.code(500).send({ error: "Внутренняя ошибка сервера" });
});
await registerAdminNodeRoutes(app);

test("an admin moves a project's pin, and unsafe targets are refused", async () => {
  try {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const nodes: Array<{ id: string; address: string; used: number; containers: number; seen: string }> = [
      { id: "local", address: "", used: 1024, containers: 4, seen: now },
      { id: "node-2", address: "10.0.0.5:8790", used: 256, containers: 1, seen: now },
      { id: "sleepy", address: "10.0.0.9:8790", used: 0, containers: 1, seen: stale },
    ];
    for (const item of nodes) {
      await upsertNode({
        id: item.id,
        address: item.address,
        status: "online",
        memoryTotalMb: 4096,
        memoryUsedMb: item.used,
        containers: item.containers,
        lastSeenAt: item.seen,
        createdAt: now,
        updatedAt: now,
      });
    }

    const project = await createProject("перенос", undefined, "user-1");
    assert.equal(project.node, "node-2", "проект должен встать на самый свободный узел");

    const anonymous = await app.inject({
      method: "POST",
      url: "/api/admin/projects/" + project.id + "/node",
      payload: { node: "local" },
    });
    assert.equal(anonymous.statusCode, 401);

    const moved = await app.inject({
      method: "POST",
      url: "/api/admin/projects/" + project.id + "/node",
      headers: auth,
      payload: { node: "local" },
    });
    assert.equal(moved.statusCode, 200);
    const body = moved.json() as { moved: boolean; project: { node: string }; node: { id: string; freeMemoryMb: number } };
    assert.equal(body.moved, true);
    assert.equal(body.project.node, "local");
    assert.equal(body.node.id, "local");
    assert.equal((await getProject(project.id))?.node, "local");

    const again = await app.inject({
      method: "POST",
      url: "/api/admin/projects/" + project.id + "/node",
      headers: auth,
      payload: { node: "local" },
    });
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { moved: boolean }).moved, false);

    const staleTarget = await app.inject({
      method: "POST",
      url: "/api/admin/projects/" + project.id + "/node",
      headers: auth,
      payload: { node: "sleepy" },
    });
    assert.equal(staleTarget.statusCode, 409);
    assert.equal((staleTarget.json() as { code: string }).code, "NODE_STALE");
    assert.equal((await getProject(project.id))?.node, "local", "отказ не должен менять закрепление");

    const unknownNode = await app.inject({
      method: "POST",
      url: "/api/admin/projects/" + project.id + "/node",
      headers: auth,
      payload: { node: "missing" },
    });
    assert.equal(unknownNode.statusCode, 404);

    const unknownProject = await app.inject({
      method: "POST",
      url: "/api/admin/projects/missing/node",
      headers: auth,
      payload: { node: "local" },
    });
    assert.equal(unknownProject.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_NODE_ID;
    delete process.env.WEBNESTDEV_SHARED_SANDBOX;
  }
});
