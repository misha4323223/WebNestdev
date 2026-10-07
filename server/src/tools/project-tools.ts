import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { registerTool } from "../tool-registry.js";

const sandboxRoot = path.resolve(
  process.env.WEBNESTDEV_SANDBOX_DIR ?? ".webnestdev/sandboxes",
);

function projectPath(projectId: string) {
  return path.join(sandboxRoot, projectId);
}

function safePath(projectId: string, relative: string) {
  const root = projectPath(projectId);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path escapes project sandbox");
  }
  return target;
}

registerTool({
  name: "project.list_files",
  description: "List files in the current project sandbox.",
  async (_input, context) {
    const root = (await getSandbox(context.projectId, context.userId)).root;
    const entries = await readdir(root, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
  },
});

registerTool({
  name: "project.stat",
  description: "Read basic metadata for a path inside the project sandbox.",
  async (input, context) {
    const value = input as { path?: string };
    const relative = value.path ?? ".";
    const sandbox = await getSandbox(context.projectId, context.userId);
    const info = await stat(assertInsideSandbox(sandbox.root, `${sandbox.root}/${relative}`));
    return {
      path: relative,
      directory: info.isDirectory(),
      size: info.size,
    };
  },
});
