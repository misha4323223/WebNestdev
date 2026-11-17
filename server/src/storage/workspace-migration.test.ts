import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("a lost workspace moves its pin only after the target restores the snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-migration-"));
  const data = path.join(root, "data");
  const workspaces = path.join(root, "workspaces");
  const token = "m".repeat(40);
  process.env.WEBNESTDEV_DATA_DIR = data;
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_NODE_ID = "node-1";
  process.env.WEBNESTDEV_WORKSPACE_MODE = "local";
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR = workspaces;
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR = workspaces;
  process.env.WEBNESTDEV_INTERNAL_TOKEN = token;

  let restored = false;
  const target = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      restored = JSON.parse(Buffer.concat(chunks).toString("utf8")).projectId === "p1";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("target has no port");

  try {
    const now = new Date().toISOString();
    await mkdir(path.join(data, "projects"), { recursive: true });
    await writeFile(
      path.join(data, "projects", "p1.json"),
      JSON.stringify({
        id: "p1",
        name: "P1",
        userId: "u1",
        node: "node-1",
        workspaceMode: "local",
        workspaceEpoch: 4,
        snapshotKey: "test/projects/u1/p1/snapshots/x.tar.gz",
        snapshotAt: now,
        workspaceBytes: 100,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const { upsertNode } = await import("../nodes/node-store.js");
    await upsertNode({
      id: "node-2",
      address: "127.0.0.1:8790",
      apiAddress: "127.0.0.1:" + address.port,
      workspaceMode: "local",
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

    const { restoreLostWorkspaceToNode } = await import("./workspace-migration.js");
    const result = await restoreLostWorkspaceToNode("p1", "u1", "node-2");
    assert.equal(restored, true);
    assert.equal(result.from, "node-1");
    assert.equal(result.to, "node-2");
    assert.equal(result.workspaceEpoch, 5);
    const { getProject } = await import("../project-store.js");
    assert.equal((await getProject("p1"))?.node, "node-2");
    assert.equal((await getProject("p1"))?.workspaceEpoch, 5);
  } finally {
    await new Promise<void>(resolve => target.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_NODE_ID;
    delete process.env.WEBNESTDEV_WORKSPACE_MODE;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR;
    delete process.env.WEBNESTDEV_INTERNAL_TOKEN;
  }
});
