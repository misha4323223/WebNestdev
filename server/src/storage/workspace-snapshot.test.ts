import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("snapshot does not delete the workspace and restores it atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-snapshot-"));
  const data = path.join(root, "data");
  const workspaces = path.join(root, "workspaces");
  process.env.WEBNESTDEV_DATA_DIR = data;
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_WORKSPACE_MODE = "local";
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR = workspaces;
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR = workspaces;

  try {
    const projectId = "p-snapshot";
    const projectRoot = path.join(workspaces, projectId);
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "index.ts"), "export const value = 1;\n");
    await mkdir(path.join(data, "projects"), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      path.join(data, "projects", projectId + ".json"),
      JSON.stringify({
        id: projectId,
        name: "Snapshot",
        userId: "u1",
        node: "node-1",
        workspaceMode: "local",
        workspaceEpoch: 3,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const objects = new Map<string, Buffer>();
    const store = {
      prefix: "test",
      async putFile(key: string, file: string) {
        const value = await readFile(file);
        objects.set(key, value);
        return value.length;
      },
      async getToFile(key: string, file: string) {
        const value = objects.get(key);
        if (!value) return false;
        await writeFile(file, value);
        return true;
      },
      async head(key: string) {
        const value = objects.get(key);
        return value ? { size: value.length } : null;
      },
      async remove(key: string) {
        objects.delete(key);
      },
      async removePrefix(prefix: string) {
        let removed = 0;
        for (const key of [...objects.keys()]) {
          if (key.startsWith(prefix)) {
            objects.delete(key);
            removed++;
          }
        }
        return removed;
      },
    };

    const { snapshotProject, restoreProjectSnapshot } = await import("./workspace-snapshot.js");
    const snapshot = await snapshotProject(projectId, "u1", { store });
    assert.ok(snapshot.bytes > 0);
    assert.equal(await readFile(path.join(projectRoot, "index.ts"), "utf8"), "export const value = 1;\n");
    assert.ok(objects.has(snapshot.key));
    assert.ok(objects.has(snapshot.key + ".json"));

    await writeFile(path.join(projectRoot, "index.ts"), "export const value = 2;\n");
    const second = await snapshotProject(projectId, "u1", { store });
    assert.ok(second.key !== snapshot.key);
    assert.equal(objects.has(snapshot.key), false, "старый snapshot удаляется, чтобы не копить бакет");
    assert.equal(objects.has(snapshot.key + ".json"), false);

    await restoreProjectSnapshot(projectId, "u1", { store });
    assert.equal(await readFile(path.join(projectRoot, "index.ts"), "utf8"), "export const value = 2;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_WORKSPACE_MODE;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR;
  }
});
