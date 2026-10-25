import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { deleteInside, listInside, readFileBytesInside, readFileInside, renameInside, writeFileInside } from "../sandbox/path-guard.js";
import { looksBinary } from "../sandbox/binary.js";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import { registerTool } from "../tool-registry.js";
import { parseChangedSource } from "../qa/change-parser.js";
import { assertNotSecretProjectPath, isSecretProjectPath } from "../secrets/secret-paths.js";

/**
 * Сервер пишет от root, а команды проекта выполняются в контейнере от uid 1000: созданные
 * файл и каталоги сразу открываются на запись, иначе агент не сможет собрать проект рядом с ними.
 */
async function openCreated(sandboxRoot: string, filePath: string) {
  await openDirsForSandbox(sandboxRoot, path.dirname(filePath));
  await openFileForSandbox(filePath);
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
    const sandbox = await getSandbox(context.projectId, context.userId);
    const entries = await listInside(sandbox.root, path.join(sandbox.root, value.path ?? "."));
    // Имя секретного файла тоже скрыто: агент не должен даже выбирать его как цель чтения.
    return entries
      .filter((entry) => !isSecretProjectPath(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
  },
});

registerTool({
  name: "fs.read",
  description: "Read a UTF-8 text file, or one window of a large one. Input: {path:string,offset?:number,limit?:number}. Large files come back in windows with `nextOffset` — read the next window instead of assuming the file ends here. Binary files (images, fonts, archives) return {binary:true,bytes} instead of text — do not try to read them as source.",
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
    assertNotSecretProjectPath(value.path, "читать");
    const sandbox = await getSandbox(context.projectId, context.userId);
    const bytes = await readFileBytesInside(sandbox.root, path.join(sandbox.root, value.path));
    // Двоичный файл не отдаётся как текст: иначе PNG или шрифт занимает контекст символами
    // замены и ничего не объясняет. Факт «это не текст» и размер — уже полезный ответ.
    if (looksBinary(bytes)) {
      return {
        path: value.path,
        binary: true,
        bytes: bytes.length,
        hint: "Это двоичный файл (изображение, шрифт, архив и т.п.) — как текст он не читается. Откройте его в панели «Файлы» или проверьте через file/identify в terminal.exec.",
      };
    }
    const content = bytes.toString("utf8");
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
    assertNotSecretProjectPath(value.path, "перезаписать");
    const sandbox = await getSandbox(context.projectId, context.userId);
    const written = await writeFileInside(sandbox.root, path.join(sandbox.root, value.path), value.content);
    await openCreated(sandbox.root, written);
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
    assertNotSecretProjectPath(value.from, "переименовать");
    assertNotSecretProjectPath(value.to, "переименовать в");
    const sandbox = await getSandbox(context.projectId, context.userId);
    await renameInside(sandbox.root, path.join(sandbox.root, value.from), path.join(sandbox.root, value.to));
    await openCreated(sandbox.root, path.join(sandbox.root, value.to));
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
    assertNotSecretProjectPath(value.path, "удалить");
    const sandbox = await getSandbox(context.projectId, context.userId);
    const candidate = path.join(sandbox.root, value.path);
    let removedChanges: ReturnType<typeof parseChangedSource>["changes"] = [];
    try {
      const source = await readFileInside(sandbox.root, candidate);
      removedChanges = parseChangedSource(value.path, source).changes.map(change => ({ ...change, action: "removed" as const }));
    } catch {
      // Каталог, двоичный файл или ссылка: источник для «удалённых изменений» не нужен,
      // само удаление ниже решает, что произойдёт.
    }
    await deleteInside(sandbox.root, candidate);
    return { ok: true, path: value.path, removedChanges };
  },
});
