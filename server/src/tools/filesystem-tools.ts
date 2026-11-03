import { createHash } from "node:crypto";
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

/**
 * A file read twice in one run is usually the same file: the first read is still in the history.
 * Returning a short marker and a preview keeps the second copy out of the context, while `fresh`
 * gives the model the full text when it really needs it again. The cache is per run and per
 * path/window, invalidated by every write, edit, rename or delete.
 */
type ReadCacheEntry={hash:string;preview:string;totalChars:number;offset:number;limit:number;truncated:boolean;nextOffset?:number};
const readCache=new Map<string,ReadCacheEntry>();
const READ_CACHE_ENTRIES=192;
const CACHED_READ_PREVIEW_CHARS=800;

function cachePath(value:string){return path.normalize(value).replace(/^\.\//,"").replace(/\\/g,"/");}
function cacheKey(projectId:string,runId:string,file:string,offset:number,limit:number){return projectId+"\u0000"+runId+"\u0000"+cachePath(file)+"\u0000"+offset+"\u0000"+limit;}
function invalidateReadCache(projectId:string,runId:string,file:string){
  const prefix=projectId+"\u0000"+runId+"\u0000"+cachePath(file)+"\u0000";
  for(const key of readCache.keys())if(key.startsWith(prefix))readCache.delete(key);
}
function rememberRead(key:string,entry:ReadCacheEntry){
  readCache.delete(key);
  readCache.set(key,entry);
  while(readCache.size>READ_CACHE_ENTRIES){
    const oldest=readCache.keys().next().value;
    if(oldest===undefined)break;
    readCache.delete(oldest);
  }
}

function countOccurrences(text:string,needle:string){
  if(!needle)return 0;
  let count=0,at=0;
  while((at=text.indexOf(needle,at))!==-1){count++;at+=needle.length;}
  return count;
}

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
  description: "Read a UTF-8 text file, or one window of a large one. Input: {path:string,offset?:number,limit?:number,fresh?:boolean}. Large files come back in windows with `nextOffset` — read the next window instead of assuming the file ends here. A file already read unchanged in this run returns a short {cached:true} marker; pass fresh:true when you need the full text again. Binary files (images, fonts, archives) return {binary:true,bytes} instead of text — do not try to read them as source.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Путь к файлу внутри проекта" },
      offset: { type: "number", description: "С какого символа читать; по умолчанию с начала" },
      limit: { type: "number", description: "Сколько символов вернуть; по умолчанию " + READ_WINDOW_CHARS + ", максимум " + READ_MAX_CHARS },
      fresh: { type: "boolean", description: "Вернуть полный текст, даже если файл уже читали в этом запуске" },
    },
  },
  execute: async (input, context) => {
    const value = input as { path?: string; offset?: number; limit?: number; fresh?: boolean };
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
    const key = cacheKey(context.projectId, context.runId, value.path, offset, limit);
    const hash = createHash("sha1").update(content).digest("hex");
    const cached = readCache.get(key);
    if (!value.fresh && cached?.hash === hash) {
      return {
        path: value.path,
        content: cached.preview,
        totalChars: cached.totalChars,
        offset,
        truncated: cached.truncated,
        cached: true,
        unchanged: true,
        previewChars: cached.preview.length,
        contentComplete: cached.preview.length >= (cached.truncated ? cached.limit : cached.totalChars - offset),
        ...(cached.truncated ? { nextOffset: cached.nextOffset } : {}),
        hint: "Файл не изменился с прошлого чтения в этом запуске — показано только начало окна. Если полный текст нужен снова, вызови fs.read с fresh:true.",
      };
    }
    rememberRead(key, {
      hash,
      preview: window.slice(0, CACHED_READ_PREVIEW_CHARS),
      totalChars: content.length,
      offset,
      limit,
      truncated,
      ...(truncated ? { nextOffset: offset + window.length } : {}),
    });
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
    invalidateReadCache(context.projectId, context.runId, value.path);
    await openCreated(sandbox.root, written);
    return {
      ok: true,
      path: value.path,
      bytes: Buffer.byteLength(value.content),
    };
  },
});

registerTool({
  name: "fs.edit",
  description: "Replace an exact fragment in a UTF-8 file without rewriting the whole file. Input: {path:string,oldText:string,newText:string,replaceAll?:boolean}. `oldText` must match exactly once unless replaceAll is true. Prefer this over fs.write for small changes: the call carries only the fragment, so it stays cheap and survives the context budget.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "oldText", "newText"],
    properties: {
      path: { type: "string", description: "Путь к файлу внутри проекта" },
      oldText: { type: "string", description: "Точный фрагмент, который нужно заменить (включая отступы)" },
      newText: { type: "string", description: "Новый текст на месте фрагмента" },
      replaceAll: { type: "boolean", description: "Заменить все вхождения; по умолчанию фрагмент обязан быть уникальным" },
    },
  },
  execute: async (input, context) => {
    const value = input as { path?: string; oldText?: string; newText?: string; replaceAll?: boolean };
    if (!value.path || typeof value.oldText !== "string" || typeof value.newText !== "string") {
      throw new Error("нужны путь, oldText и newText");
    }
    if (!value.oldText) throw new Error("oldText не может быть пустым");
    if (value.oldText === value.newText) throw new Error("oldText и newText совпадают — файл не изменится");
    assertNotSecretProjectPath(value.path, "изменить");
    const sandbox = await getSandbox(context.projectId, context.userId);
    const file = path.join(sandbox.root, value.path);
    const bytes = await readFileBytesInside(sandbox.root, file);
    if (looksBinary(bytes)) throw new Error("файл двоичный, точечная правка текста невозможна");
    const before = bytes.toString("utf8");
    const occurrences = countOccurrences(before, value.oldText);
    if (!occurrences) {
      throw new Error("oldText не найден в файле — прочитай актуальное содержимое через fs.read и повтори правку");
    }
    if (occurrences > 1 && value.replaceAll !== true) {
      throw new Error("oldText встречается " + occurrences + " раз — уточни фрагмент или передай replaceAll:true");
    }
    const after = value.replaceAll === true
      ? before.split(value.oldText).join(value.newText)
      : before.slice(0, before.indexOf(value.oldText)) + value.newText + before.slice(before.indexOf(value.oldText) + value.oldText.length);
    if (after === before) throw new Error("текст не изменился");
    const written = await writeFileInside(sandbox.root, file, after);
    invalidateReadCache(context.projectId, context.runId, value.path);
    await openCreated(sandbox.root, written);
    return {
      ok: true,
      path: value.path,
      replacements: value.replaceAll === true ? occurrences : 1,
      bytes: Buffer.byteLength(after),
      linesBefore: before.split("\n").length,
      linesAfter: after.split("\n").length,
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
    invalidateReadCache(context.projectId, context.runId, value.from);
    invalidateReadCache(context.projectId, context.runId, value.to);
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
    invalidateReadCache(context.projectId, context.runId, value.path);
    return { ok: true, path: value.path, removedChanges };
  },
});
