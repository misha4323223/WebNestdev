import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("local mode refuses a remote workspace even with the old shared flag", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-local-"));
  const data = path.join(root, "data");
  const workspaces = path.join(root, "workspaces");
  process.env.WEBNESTDEV_DATA_DIR = data;
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_NODE_ID = "node-1";
  process.env.WEBNESTDEV_WORKSPACE_MODE = "local";
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR = workspaces;
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR = workspaces;
  process.env.WEBNESTDEV_SHARED_SANDBOX = "1";

  try {
    const now = new Date().toISOString();
    await mkdir(path.join(data, "projects"), { recursive: true });
    await writeFile(
      path.join(data, "projects", "remote.json"),
      JSON.stringify({ id: "remote", name: "Remote", userId: "u1", node: "node-2", createdAt: now, updatedAt: now }),
    );
    await writeFile(
      path.join(data, "projects", "local.json"),
      JSON.stringify({ id: "local", name: "Local", userId: "u1", node: "node-1", createdAt: now, updatedAt: now }),
    );

    const { getSandbox } = await import("./sandbox-service.js");
    const { WorkspaceOwnerMismatchError } = await import("./host.js");
    await assert.rejects(getSandbox("remote", "u1"), (error: unknown) => error instanceof WorkspaceOwnerMismatchError);

    const local = await getSandbox("local", "u1");
    assert.equal(local.root, path.join(workspaces, "local"));
    assert.equal(local.node, "node-1");

    const { reassignProjectNode, deleteProject, WorkspaceMigrationRequiredError } = await import("../project-store.js");
    await assert.rejects(
      reassignProjectNode("local", "u1", "node-2"),
      (error: unknown) => error instanceof WorkspaceMigrationRequiredError,
    );
    await assert.rejects(
      deleteProject("remote", "u1"),
      (error: unknown) => error instanceof WorkspaceMigrationRequiredError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_DATA_DIR;
    delete process.env.WEBNESTDEV_STORAGE;
    delete process.env.WEBNESTDEV_NODE_ID;
    delete process.env.WEBNESTDEV_WORKSPACE_MODE;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR;
    delete process.env.WEBNESTDEV_SHARED_SANDBOX;
  }
});
