import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { registerTool } from "../tool-registry.js";
import { parseChangedSource } from "../qa/change-parser.js";

async function target(projectId: string, userId: string, relative: string) {
  const sandbox = await getSandbox(projectId, userId);
  const safePath = assertInsideSandbox(
    sandbox.root,
    path.join(sandbox.root, relative || "."),
  );
  return { sandbox, path: safePath };
}

/** Сколько читается за один вызов и сколько вообще разрешено вернуть. */
const READ_WINDOW_CHARS = 20000;
const READ_MAX_CHARS = 60000;

registerTool({
  name: "fs.list",
  description: "List files and directories. Input: {path?: string}.",
  parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Каталог внутри проекта; по умолчанию корень проекта" } } },
  execute: async (input, context) => {
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
  description: "Read a UTF-8 text file, or one window of a large one. Input: {path:string,offset?:number,limit?:number}. Large files come back in windows with `nextOffset` — read the next window instead of assuming the file ends here.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Путь к файлу внутри проекта" },
      offset: { type: "number", description: "С какого символа читать; по умолчанию с начала" },
      limit: { type: "number", description: "Сколько символов вернуть; по умолчанию " + READ_WINDOW_CHARS + ", максимум " + READ_MAX_CHARS },
    },
  },
  execute: async (input, context) => {
    const value = input as { path?: string; offset?: number; limit?: number };
    if (!value.path) throw new Error("не указан путь");
    const resolved = await target(context.projectId, context.userId, value.path);
    const content = await readFile(resolved.path, "utf8");
    // Окно, а не весь файл: неограниченное чтение — то, из-за чего запуск упирался в лимит модели.
    const offset = Math.max(0, Math.floor(Number(value.offset) || 0));
    const limit = Math.min(READ_MAX_CHARS, Math.max(1, Math.floor(Number(value.limit) || READ_WINDOW_CHARS)));
    const window = content.slice(offset, offset + limit);
    const truncated = offset + window.length < content.length;
    return {
      path: value.path,
      content: window,
      totalChars: content.length,
      offset,
      truncated,
      ...(truncated ? { nextOffset: offset + window.length, hint: "Продолжение: fs.read с offset=" + (offset + window.length) } : {}),
    };
  },
});

registerTool({
  name: "fs.write",
  description: "Create or replace a UTF-8 text file. Input: {path:string,content:string}.",
  parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string", description: "Путь к файлу внутри проекта" }, content: { type: "string", description: "Полное содержимое файла" } } },
  execute: async (input, context) => {
    const value = input as { path?: string; content?: string };
    if (!value.path || typeof value.content !== "string") {
      throw new Error("нужны путь и содержимое файла");
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
  parameters: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string", description: "Текущий путь" }, to: { type: "string", description: "Новый путь" } } },
  execute: async (input, context) => {
    const value = input as { from?: string; to?: string };
    if (!value.from || !value.to) throw new Error("нужны пути from и to");
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
  parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", description: "Путь внутри проекта; корень проекта удалить нельзя" } } },
  execute: async (input, context) => {
    const value = input as { path?: string };
    if (!value.path || value.path === ".") {
      throw new Error("Отказано: нельзя удалить корень песочницы");
    }
    const resolved = await target(context.projectId, context.userId, value.path);
    let removedChanges: ReturnType<typeof parseChangedSource>["changes"] = [];
    try {
      const source = await readFile(resolved.path, "utf8");
      removedChanges = parseChangedSource(value.path, source).changes.map(change => ({ ...change, action: "removed" as const }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(resolved.path, { recursive: true, force: true });
    return { ok: true, path: value.path, removedChanges };
  },
});
