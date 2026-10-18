import { lstat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { listInside, resolveInsideSandbox } from "../sandbox/path-guard.js";
import { registerTool } from "../tool-registry.js";
import { assertNotSecretProjectPath, isSecretProjectPath } from "../secrets/secret-paths.js";

registerTool({
  name: "project.list_files",
  description: "List files in the current project sandbox.",
  execute: async (_input, context) => {
    const sandbox = await getSandbox(context.projectId, context.userId);
    const entries = await listInside(sandbox.root, sandbox.root);
    return entries
      .filter((entry) => !isSecretProjectPath(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
  },
});

registerTool({
  name: "project.stat",
  description: "Read basic metadata for a path inside the project sandbox.",
  execute: async (input, context) => {
    const value = input as { path?: string };
    const relative = value.path ?? ".";
    assertNotSecretProjectPath(relative, "читать метаданные");
    const sandbox = await getSandbox(context.projectId, context.userId);
    // realpath, а не лексическая проверка: ссылка наружу — это уже не путь проекта.
    const resolved = await resolveInsideSandbox(sandbox.root, path.join(sandbox.root, relative));
    const info = await lstat(resolved);
    return {
      path: relative,
      directory: info.isDirectory(),
      size: info.size,
    };
  },
});
