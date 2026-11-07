import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "local";
process.env.WEBNESTDEV_SHARED_SANDBOX = "1";
process.env.WEBNESTDEV_REBALANCE_PROJECTS = "1";
const root = await mkdtemp(path.join(tmpdir(), "rebalance-tick-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const { upsertNode } = await import("./node-store.js");
const { rebalanceOnce } = await import("./rebalance.js");
const { createProject, getProject, reassignProjectNode } = await import("../project-store.js");

test("one tick moves a project from the crowded node to the roomy one", async () => {
  try {
    const now = new Date().toISOString();
    for (const item of [
      { id: "local", address: "", used: 3600 },
      { id: "node-2", address: "10.0.0.5:8790", used: 200 },
    ]) {
      await upsertNode({
        id: item.id,
        address: item.address,
        status: "online",
        memoryTotalMb: 4096,
        memoryUsedMb: item.used,
        containers: 1,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    const project = await createProject("на переезд", undefined, "user-1");
    assert.equal(project.node, "node-2", "новый проект встаёт на самый свободный узел");
    // Проект, закреплённый за узлом до того, как тот стал тесным.
    assert.ok(await reassignProjectNode(project.id, "user-1", "local"));

    const messages: string[] = [];
    const moved = await rebalanceOnce(message => messages.push(message));
    assert.equal(moved?.projectId, project.id);
    assert.equal(moved?.from, "local");
    assert.equal(moved?.to, "node-2");
    assert.equal((await getProject(project.id))?.node, "node-2");
    assert.match(messages.join("\n"), /перенесён с local на node-2/);

    // Второй проход ничего не делает: разница уже ниже порога.
    assert.equal(await rebalanceOnce(message => messages.push(message)), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_NODE_ID;
    delete process.env.WEBNESTDEV_SHARED_SANDBOX;
    delete process.env.WEBNESTDEV_REBALANCE_PROJECTS;
  }
});
