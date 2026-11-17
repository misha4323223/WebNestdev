import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("pilot project uses the local root while shared projects keep Gluster", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-pilot-"));
  const shared = path.join(root, "shared");
  const local = path.join(root, "local");
  process.env.WEBNESTDEV_WORKSPACE_MODE = "shared";
  process.env.WEBNESTDEV_LOCAL_PROJECTS = "pilot";
  process.env.WEBNESTDEV_SANDBOX_DIR = shared;
  process.env.WEBNESTDEV_SANDBOX_HOST_DIR = shared;
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR = local;
  process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR = local;

  try {
    const { sandboxRootPath, workspaceRoots } = await import("./config.js");
    const { isLocalWorkspace } = await import("./workspace-mode.js");

    assert.equal(isLocalWorkspace("pilot"), true);
    assert.equal(isLocalWorkspace("other"), false);
    assert.equal(sandboxRootPath("pilot"), path.join(local, "pilot"));
    assert.equal(sandboxRootPath("other"), path.join(shared, "other"));
    assert.deepEqual(workspaceRoots("pilot"), { serverDir: local, hostDir: local });
    assert.deepEqual(workspaceRoots("other"), { serverDir: shared, hostDir: shared });
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_WORKSPACE_MODE;
    delete process.env.WEBNESTDEV_LOCAL_PROJECTS;
    delete process.env.WEBNESTDEV_SANDBOX_DIR;
    delete process.env.WEBNESTDEV_SANDBOX_HOST_DIR;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_DIR;
    delete process.env.WEBNESTDEV_LOCAL_WORKSPACE_HOST_DIR;
  }
});
