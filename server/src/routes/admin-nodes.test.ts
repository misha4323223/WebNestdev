import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "local";
const root = await mkdtemp(path.join(tmpdir(), "admin-nodes-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminNodeRoutes } = await import("./admin-nodes.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { upsertNode } = await import("../nodes/node-store.js");
const { ZodError } = await import("zod");

const admin = await createAdmin("nodes-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };
const app = Fastify();
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: "Некорректный запрос" });
  return reply.code(500).send({ error: "Внутренняя ошибка сервера" });
});
await registerAdminNodeRoutes(app);

test("nodes are visible to an admin and drain is an explicit status change", async () => {
  try {
    const now = new Date().toISOString();
    await upsertNode({
      id: "local",
      address: "",
      status: "online",
      memoryTotalMb: 4096,
      memoryUsedMb: 1024,
      containers: 2,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const anonymous = await app.inject({ method: "GET", url: "/api/admin/nodes" });
    assert.equal(anonymous.statusCode, 401);

    const listed = await app.inject({ method: "GET", url: "/api/admin/nodes", headers: auth });
    assert.equal(listed.statusCode, 200);
    const listBody = listed.json() as { localNodeId: string; nodes: Array<{ id: string; status: string; projects: number; freeMemoryMb: number }> };
    assert.equal(listBody.localNodeId, "local");
    assert.equal(listBody.nodes[0]?.status, "online");
    assert.equal(listBody.nodes[0]?.freeMemoryMb, 3072);

    const badConfirm = await app.inject({
      method: "POST",
      url: "/api/admin/nodes/local/status",
      headers: auth,
      payload: { status: "draining", confirm: false },
    });
    assert.equal(badConfirm.statusCode, 400);

    const drained = await app.inject({
      method: "POST",
      url: "/api/admin/nodes/local/status",
      headers: auth,
      payload: { status: "draining", confirm: true },
    });
    assert.equal(drained.statusCode, 200);
    const drainBody = drained.json() as { node: { status: string }; warning?: string };
    assert.equal(drainBody.node.status, "draining");
    assert.match(drainBody.warning ?? "", /онлайн-узла/);

    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/nodes/missing/status",
      headers: auth,
      payload: { status: "offline", confirm: true },
    });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_NODE_ID;
  }
});
