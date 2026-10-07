import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { registerTool } from "../tool-registry.js";

async function target(projectId: string, userId: string, relative: string) {
  const sandbox = await getSandbox(projectId, userId);
  const safePath = assertInsideSandbox(
    sandbox.root,
    path.join(sandbox.root, relative || "."),
  );
  return { sandbox, path: safePath };
}

registerTool({
  name: "fs.list",
  description: "List files and directories. Input: {path?: string}.",
  execute: async (input, context) {
    const value = input as { path?: string };
    const { path: targetPath } = await target(context.projectId, context.userId, value.path ?? ".");
    const entries = await readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
    }));
  },
});

registerTool({
  name: "fs.read",
  description: "Read a UTF-8 text file. Input: {path:string}.",
  execute: async (input, context) {
    const value = input as { path?: string };
    if (!value.path) throw new Error("path is required");
    const resolved = await target(context.projectId, context.userId, value.path);
    return { path: value.path, content: await readFile(resolved.path, "utf8") };
  },
});

registerTool({
  name: "fs.write",
  description: "Create or replace a UTF-8 text file. Input: {path:string,content:string}.",
  execute: async (input, context) {
    const value = input as { path?: string; content?: string };
    if (!value.path || typeof value.content !== "string") {
      throw new Error("path and content are required");
    }
    const resolved = await target(context.projectId, context.userId, value.path);
    await mkdir(path.dirname(resolved.path), { recursive: true });
    await writeFile(resolved.path, value.content, "utf8");
    return {
      ok: true,
      path: value.path,
      bytes: Buffer.byteLength(value.content),
    };
  },
});

registerTool({
  name: "fs.rename",
  description: "Rename a path inside the project. Input: {from:string,to:string}.",
  execute: async (input, context) {
    const value = input as { from?: string; to?: string };
    if (!value.from || !value.to) throw new Error("from and to are required");
    const from = await target(context.projectId, context.userId, value.from);
    const to = await target(context.projectId, context.userId, value.to);
    await mkdir(path.dirname(to.path), { recursive: true });
    await rename(from.path, to.path);
    return { ok: true, from: value.from, to: value.to };
  },
});

registerTool({
  name: "fs.delete",
  description: "Delete a path inside the project. Input: {path:string}.",
  execute: async (input, context) {
    const value = input as { path?: string };
    if (!value.path || value.path === ".") {
      throw new Error("Refusing to delete sandbox root");
    }
    const resolved = await target(context.projectId, context.userId, value.path);
    await rm(resolved.path, { recursive: true, force: true });
    return { ok: true, path: value.path };
  },
});
