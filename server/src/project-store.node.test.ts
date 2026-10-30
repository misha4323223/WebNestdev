import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "local";
const root = await mkdtemp(path.join(tmpdir(), "project-node-"));
process.env.WEBNESTDEV_DATA_DIR = root;

test("a new project is pinned to the selected registry node", async () => {
  try {
    const { createProject, getProject } = await import("./project-store.js");
    const { listNodes } = await import("./nodes/node-store.js");
    const project = await createProject("Node pin", undefined, "node-pin-user");
    assert.equal(project.node, "local");
    assert.equal((await getProject(project.id))?.node, "local");
    assert.deepEqual((await listNodes()).map(node => node.id), ["local"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_NODE_ID;
  }
});
