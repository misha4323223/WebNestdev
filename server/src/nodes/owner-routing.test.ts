import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("a project request is streamed to its owner through the internal token", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-routing-"));
  const token = "i".repeat(40);
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_NODE_ID = "node-1";
  process.env.WEBNESTDEV_OWNER_ROUTING = "1";
  process.env.WEBNESTDEV_INTERNAL_TOKEN = token;

  let seen: { method?: string; url?: string; marker?: string; token?: string; body?: string } = {};
  const owner = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      seen = {
        method: request.method,
        url: request.url,
        marker: String(request.headers["x-webnestdev-internal"] ?? ""),
        token: String(request.headers["x-webnestdev-internal-token"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(201, { "content-type": "text/plain", "x-owner": "node-2" });
      response.end("served by node-2");
    });
  });
  await new Promise<void>(resolve => owner.listen(0, "127.0.0.1", resolve));
  const ownerAddress = owner.address();
  if (!ownerAddress || typeof ownerAddress === "string") throw new Error("owner server has no port");

  try {
    await mkdir(path.join(root, "projects"), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      path.join(root, "projects", "p1.json"),
      JSON.stringify({ id: "p1", name: "P1", userId: "u1", node: "node-2", createdAt: now, updatedAt: now }),
    );

    const { default: Fastify } = await import("fastify");
    const { registerOwnerRouting } = await import("./owner-router.js");
    const { upsertNode } = await import("./node-store.js");
    await upsertNode({
      id: "node-2",
      address: "127.0.0.1:8790",
      apiAddress: "127.0.0.1:" + ownerAddress.port,
      workspaceMode: "shared",
      status: "online",
      memoryTotalMb: 4096,
      memoryUsedMb: 0,
      containers: 0,
      diskTotalMb: 19_000,
      diskFreeMb: 12_000,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const app = Fastify();
    registerOwnerRouting(app);
    app.get("/api/projects/:id/files", async () => ({ served: "locally" }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("API has no port");

    const response = await fetch("http://127.0.0.1:" + address.port + "/api/projects/p1/files?path=a.txt", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-owner"), "node-2");
    assert.equal(await response.text(), "served by node-2");
    assert.deepEqual(seen, {
      method: "POST",
      url: "/api/projects/p1/files?path=a.txt",
      marker: "1",
      token,
      body: "hello",
    });

    await app.close();
  } finally {
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_NODE_ID;
    delete process.env.WEBNESTDEV_OWNER_ROUTING;
    delete process.env.WEBNESTDEV_INTERNAL_TOKEN;
  }
});
