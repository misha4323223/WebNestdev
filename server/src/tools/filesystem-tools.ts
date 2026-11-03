import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { deleteInside, listInside, readFileBytesInside, readFileInside, renameInside, resolveInsideSandbox, writeFileInside } from "../sandbox/path-guard.js";
import { looksBinary } from "../sandbox/binary.js";
import { openDirsForSandbox, openFileForSandbox } from "../sandbox/permissions.js";
import { registerTool } from "../tool-registry.js";
import { parseChangedSource } from "../qa/change-parser.js";
import { splitLines, unifiedPatch } from "../changes/diff.js";
import { assertNotSecretProjectPath, isSecretProjectPath } from "../secrets/secret-paths.js";
import { IGNORED_PROJECT_DIRS } from "../project-ignore.js";

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
/** Окно построчного чтения: 120 строк — обычный размер функции или секции. */
const READ_LINE_WINDOW = 120;
const READ_LINE_MAX = 400;
/** Компактный diff правки: модель читает подтверждение, а не весь файл. */
const EDIT_DIFF_MAX_CHARS = 5000;

/**
 * A file read twice in one run is usually the same file: the first read is still in the history.
 * Returning a short marker and a preview keeps the second copy out of the context, while `fresh`
 * gives the model the full text when it really needs it again. The cache is per run and per
 * path/window, invalidated by every write, edit, rename or delete.
 */
type ReadCacheEntry={
  hash:string;
  preview:string;
  totalChars:number;
  /** Фактическая длина окна до обрезки preview: по ней видно, попал ли весь ответ в кэш. */
  fullChars:number;
  offset?:number;
  limit?:number;
  lineStart?:number;
  lineEnd?:number;
  totalLines?:number;
  nextLineStart?:number;
  truncated:boolean;
  nextOffset?:number;
};
const readCache=new Map<string,ReadCacheEntry>();
const READ_CACHE_ENTRIES=192;
const CACHED_READ_PREVIEW_CHARS=800;

function cachePath(value:string){return path.normalize(value).replace(/^\.\//,"").replace(/\\/g,"/");}
function cacheKey(projectId:string,runId:string,file:string,window:string){return projectId+"\u0000"+runId+"\u0000"+cachePath(file)+"\u0000"+window;}
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
  description: "Read a UTF-8 text file, or one window of a large one. Two window modes: line mode {path,lineStart,lineLimit} with 1-based lines — preferred for source code — and character mode {path,offset,limit}. Large files come back with `nextLineStart` or `nextOffset`; read the next window instead of assuming the file ends here. A file already read unchanged in this run returns a short {cached:true} marker; pass fresh:true when you need the full text again. Binary files (images, fonts, archives) return {binary:true,bytes} instead of text — do not try to read them as source.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Путь к файлу внутри проекта" },
      lineStart: { type: "number", description: "С какой строки читать, начиная с 1; включает построчный режим" },
      lineLimit: { type: "number", description: "Сколько строк вернуть; по умолчанию " + READ_LINE_WINDOW + ", максимум " + READ_LINE_MAX },
      offset: { type: "number", description: "С какого символа читать в символьном режиме; по умолчанию с начала" },
      limit: { type: "number", description: "Сколько символов вернуть в символьном режиме; по умолчанию " + READ_WINDOW_CHARS + ", максимум " + READ_MAX_CHARS },
      fresh: { type: "boolean", description: "Вернуть полный текст, даже если файл уже читали в этом запуске" },
    },
  },
  execute: async (input, context) => {
    const value = input as { path?: string; lineStart?: number; lineLimit?: number; offset?: number; limit?: number; fresh?: boolean };
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
    const hash = createHash("sha1").update(content).digest("hex");
    const lineMode = typeof value.lineStart === "number" && Number.isFinite(value.lineStart);

    if (lineMode) {
      const lines = splitLines(content);
      const totalLines = lines.length;
      const requestedStart = Math.max(1, Math.floor(Number(value.lineStart) || 1));
      if (!totalLines || requestedStart > totalLines) {
        return {
          path: value.path,
          content: "",
          mode: "lines",
          totalLines,
          lineStart: requestedStart,
          lineEnd: 0,
          truncated: false,
          hint: totalLines
            ? "В файле " + totalLines + " строк — lineStart=" + requestedStart + " за концом файла."
            : "Файл пуст.",
        };
      }
      const lineStart = requestedStart;
      const requestedLimit = Math.floor(Number(value.lineLimit) || READ_LINE_WINDOW);
      const lineLimit = Math.min(READ_LINE_MAX, Math.max(1, requestedLimit));
      let lineEnd = Math.min(totalLines, lineStart - 1 + lineLimit);
      let selected = lines.slice(lineStart - 1, lineEnd);
      // Даже 400 строк с очень длинными строками не должны пробить общий предел ответа.
      while (selected.length > 1 && selected.join("\n").length > READ_MAX_CHARS) {
        selected = selected.slice(0, -1);
        lineEnd--;
      }
      let window = selected.join("\n");
      const charLimited = window.length > READ_MAX_CHARS;
      if (charLimited) window = window.slice(0, READ_MAX_CHARS);
      const truncated = lineEnd < totalLines;
      const key = cacheKey(context.projectId, context.runId, value.path, "lines:" + lineStart + ":" + lineLimit);
      const cached = readCache.get(key);
      if (!value.fresh && cached?.hash === hash) {
        return {
          path: value.path,
          content: cached.preview,
          mode: "lines",
          totalLines,
          lineStart,
          lineEnd,
          truncated: cached.truncated,
          cached: true,
          unchanged: true,
          previewChars: cached.preview.length,
          contentComplete: cached.preview.length >= cached.fullChars,
          ...(cached.nextLineStart ? { nextLineStart: cached.nextLineStart } : {}),
          hint: "Файл не изменился с прошлого чтения в этом запуске — показано только начало окна. Если полный текст нужен снова, вызови fs.read с fresh:true.",
        };
      }
      rememberRead(key, {
        hash,
        preview: window.slice(0, CACHED_READ_PREVIEW_CHARS),
        totalChars: content.length,
        fullChars: window.length,
        lineStart,
        lineEnd,
        totalLines,
        truncated,
        ...(truncated ? { nextLineStart: lineEnd + 1 } : {}),
      });
      return {
        path: value.path,
        content: window,
        mode: "lines",
        totalChars: content.length,
        totalLines,
        lineStart,
        lineEnd,
        truncated,
        ...(charLimited ? { charLimited: true, hint: "Одна выбранная строка длиннее предела чтения — она сокращена. Увеличьте lineStart или читайте символьным режимом." } : {}),
        ...(truncated
          ? { nextLineStart: lineEnd + 1, ...(charLimited ? {} : { hint: "Продолжение: fs.read с lineStart=" + (lineEnd + 1) + " и lineLimit=" + lineLimit }) }
          : {}),
        ...(!totalLines ? { hint: "Файл пуст." } : {}),
      };
    }

    // Окно, а не весь файл: неограниченное чтение — то, из-за чего запуск упирался в лимит модели.
    const offset = Math.max(0, Math.floor(Number(value.offset) || 0));
    const limit = Math.min(READ_MAX_CHARS, Math.max(1, Math.floor(Number(value.limit) || READ_WINDOW_CHARS)));
    const window = content.slice(offset, offset + limit);
    const truncated = offset + window.length < content.length;
    const key = cacheKey(context.projectId, context.runId, value.path, "chars:" + offset + ":" + limit);
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
        contentComplete: cached.preview.length >= cached.fullChars,
        ...(cached.truncated ? { nextOffset: cached.nextOffset } : {}),
        hint: "Файл не изменился с прошлого чтения в этом запуске — показано только начало окна. Если полный текст нужен снова, вызови fs.read с fresh:true.",
      };
    }
    rememberRead(key, {
      hash,
      preview: window.slice(0, CACHED_READ_PREVIEW_CHARS),
      totalChars: content.length,
      fullChars: window.length,
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
    const info = await lstat(written).catch(() => null);
    return {
      ok: true,
      path: value.path,
      bytes: Buffer.byteLength(value.content),
      ...(info ? { mtime: info.mtime.toISOString() } : {}),
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
    const info = await lstat(written).catch(() => null);
    // Правка подтверждается не словом «ok», а тем, что изменилось: несколько строк контекста
    // вокруг замены. Полный патч для большого replaceAll не нужен — он режется по лимиту.
    const patch = unifiedPatch(value.path, before, after, 3);
    const diffTruncated = patch.patch.length > EDIT_DIFF_MAX_CHARS;
    const diff = patch.patch
      ? diffTruncated
        ? patch.patch.slice(0, EDIT_DIFF_MAX_CHARS) + "\n…[дифф сокращён]"
        : patch.patch
      : undefined;
    return {
      ok: true,
      path: value.path,
      replacements: value.replaceAll === true ? occurrences : 1,
      bytes: Buffer.byteLength(after),
      linesBefore: before.split("\n").length,
      linesAfter: after.split("\n").length,
      ...(diff ? { diff } : {}),
      ...(patch.truncated ? { diffTruncated: true, diffNote: "Файл слишком велик для построчного диффа — проверьте нужный фрагмент через fs.read." } : {}),
      ...(diffTruncated ? { diffNote: "Дифф сокращён до " + EDIT_DIFF_MAX_CHARS + " символов." } : {}),
      ...(info ? { mtime: info.mtime.toISOString() } : {}),
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

/**
 * Поиск по проекту — отдельный инструмент, а не `grep` через terminal.exec.
 *
 * У оболочки два недостатка, которые мешают агенту: каждый вызов тащит в контекст шум
 * (`cd`, заголовки, коды возврата), а вывод grep нужно ещё разбирать глазами. Здесь тот же
 * поиск отдаёт структуру `{file,line,column,text}`: её можно сразу превратить в `fs.read`
 * с нужным окном и не тратить шаг на разбор текста терминала.
 */
const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const GREP_DEFAULT_RESULTS = 80;
const GREP_MAX_RESULTS = 200;
const GREP_MAX_LINE_CHARS = 260;
const GREP_CONTEXT_MAX = 4;

function normalizeProjectRelative(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Glob в стиле оболочки: `*`, `**`, `?` и `{a,b}`. Без `**` шаблон совпадает с именем файла
 * на любой глубине (`*.ts`), с `**` — с путём от корня проекта.
 */
function globMatcher(glob: string) {
  const pattern = normalizeProjectRelative(glob.trim());
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) source += "\\{";
      else {
        source += "(?:" + pattern.slice(i + 1, end).split(",").map(escapeRegExp).join("|") + ")";
        i = end;
      }
    } else source += escapeRegExp(char);
  }
  const expression = new RegExp("^" + (pattern.includes("/") ? "" : "(?:.*/)?") + source + "$");
  return (relative: string) => expression.test(relative);
}

/**
 * Все файлы под `startRelative`, кроме каталогов сборки и ссылок. Каталог, названный в `path`
 * явно, всё равно обходится: `path: "dist"` означает «искать в dist», а не «пропустить его».
 */
async function* walkProjectFiles(root: string, startRelative: string, skipped: { dirs: number }) {
  const relativeStart = normalizeProjectRelative(startRelative);
  const target = path.join(root, startRelative || ".");
  let info;
  try {
    info = await lstat(await resolveInsideSandbox(root, target));
  } catch {
    throw new Error("Путь не найден: " + (startRelative || "."));
  }
  if (info.isFile()) {
    yield { relative: relativeStart, absolute: target };
    return;
  }
  if (!info.isDirectory()) throw new Error("Поиск работает только по файлу или каталогу");
  const stack: Array<{ relative: string; absolute: string }> = [{ relative: relativeStart, absolute: target }];
  while (stack.length) {
    const dir = stack.pop() as { relative: string; absolute: string };
    let entries: Dirent[];
    try {
      entries = await listInside(root, dir.absolute);
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: Array<{ relative: string; absolute: string }> = [];
    for (const entry of entries) {
      const relative = dir.relative ? dir.relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_PROJECT_DIRS.has(entry.name) && normalizeProjectRelative(relative) !== relativeStart) {
          skipped.dirs++;
          continue;
        }
        subdirs.push({ relative, absolute: path.join(dir.absolute, entry.name) });
      } else if (entry.isFile()) {
        yield { relative, absolute: path.join(dir.absolute, entry.name) };
      }
    }
    // Разворачиваем стек в обратном порядке, чтобы обход шёл по алфавиту.
    stack.push(...subdirs.reverse());
  }
}

/** Строка вокруг совпадения: длинная строка не должна прятать сам найденный фрагмент. */
function grepLineWindow(line: string, at: number) {
  // Табы не раскрываются: `column` считается по исходной строке, и менять её длину значило бы
  // вернуть столбец, который не совпадает с текстом.
  const text = line.trimEnd();
  if (text.length <= GREP_MAX_LINE_CHARS) return text;
  const column = Math.min(Math.max(0, at), Math.max(0, text.length - 1));
  let start = Math.max(0, column - Math.floor(GREP_MAX_LINE_CHARS / 3));
  let end = Math.min(text.length, start + GREP_MAX_LINE_CHARS);
  start = Math.max(0, end - GREP_MAX_LINE_CHARS);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

registerTool({
  name: "fs.grep",
  description: "Search project text for a regular expression and get structured matches. Input: {pattern:string,path?:string,glob?:string,ignoreCase?:boolean,literal?:boolean,context?:number,maxResults?:number}. Returns {file,line,column,text} without shell noise; dependencies and build output are skipped unless `path` points inside them. Use `glob` like \"*.ts\" or \"src/**/*.{ts,tsx}\". Prefer this over terminal.exec grep.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Регулярное выражение (или литерал при literal:true)" },
      path: { type: "string", description: "Файл или каталог внутри проекта; по умолчанию весь проект" },
      glob: { type: "string", description: "Фильтр имён: *.ts, src/**/*.{ts,tsx}" },
      ignoreCase: { type: "boolean", description: "Искать без учёта регистра" },
      literal: { type: "boolean", description: "Искать pattern как обычную строку, без регулярных выражений" },
      context: { type: "number", description: "Сколько строк до и после показать (0–" + GREP_CONTEXT_MAX + ", по умолчанию 0)" },
      maxResults: { type: "number", description: "Предел совпадений, по умолчанию " + GREP_DEFAULT_RESULTS + ", максимум " + GREP_MAX_RESULTS },
    },
  },
  execute: async (input, context) => {
    const value = input as { pattern?: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; maxResults?: number };
    if (!value.pattern) throw new Error("не указан pattern для поиска");
    if (value.path) assertNotSecretProjectPath(value.path, "искать");
    let expression: RegExp;
    try {
      expression = new RegExp(value.literal ? escapeRegExp(value.pattern) : value.pattern, value.ignoreCase ? "i" : "");
    } catch (error) {
      throw new Error("pattern не является корректным регулярным выражением: " + (error instanceof Error ? error.message : String(error)));
    }
    const sandbox = await getSandbox(context.projectId, context.userId);
    const matches = globMatcher(value.glob ?? "**/*");
    const contextLines = Math.min(GREP_CONTEXT_MAX, Math.max(0, Math.floor(Number(value.context) || 0)));
    const maxResults = Math.min(GREP_MAX_RESULTS, Math.max(1, Math.floor(Number(value.maxResults) || GREP_DEFAULT_RESULTS)));
    const skipped = { dirs: 0, binary: 0, large: 0, secret: 0 };
    const matchedFiles = new Set<string>();
    const found: unknown[] = [];
    let filesScanned = 0;
    let totalBytes = 0;
    let truncated = false;
    let stopReason = "";
    outer: for await (const file of walkProjectFiles(sandbox.root, value.path ?? "", skipped)) {
      if (isSecretProjectPath(file.relative)) {
        skipped.secret++;
        continue;
      }
      const relative = normalizeProjectRelative(file.relative);
      if (!matches(relative)) continue;
      const info = await lstat(file.absolute).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > SEARCH_MAX_FILE_BYTES) {
        skipped.large++;
        continue;
      }
      if (filesScanned >= SEARCH_MAX_FILES) {
        truncated = true;
        stopReason = "fileLimit";
        break;
      }
      if (totalBytes + info.size > SEARCH_MAX_TOTAL_BYTES) {
        truncated = true;
        stopReason = "byteLimit";
        break;
      }
      let bytes: Buffer;
      try {
        bytes = await readFileBytesInside(sandbox.root, file.absolute);
      } catch {
        continue;
      }
      if (looksBinary(bytes)) {
        skipped.binary++;
        continue;
      }
      filesScanned++;
      totalBytes += bytes.length;
      const lines = bytes.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line) continue;
        const match = expression.exec(line);
        if (!match) continue;
        const before: Array<{ line: number; text: string }> = [];
        const after: Array<{ line: number; text: string }> = [];
        if (contextLines) {
          for (let i = Math.max(0, index - contextLines); i < index; i++) before.push({ line: i + 1, text: grepLineWindow(lines[i], 0) });
          for (let i = index + 1; i <= Math.min(lines.length - 1, index + contextLines); i++) after.push({ line: i + 1, text: grepLineWindow(lines[i], 0) });
        }
        found.push({
          file: relative,
          line: index + 1,
          column: match.index + 1,
          text: grepLineWindow(line, match.index),
          ...(before.length ? { before } : {}),
          ...(after.length ? { after } : {}),
        });
        matchedFiles.add(relative);
        if (found.length >= maxResults) {
          truncated = true;
          stopReason = "resultLimit";
          break outer;
        }
      }
    }
    return {
      pattern: value.pattern,
      ...(value.path ? { path: value.path } : {}),
      ...(value.glob ? { glob: value.glob } : {}),
      matches: found,
      matchCount: found.length,
      fileCount: matchedFiles.size,
      filesScanned,
      ...(truncated ? { truncated: true, stopReason, hint: "Показаны не все совпадения — сузьте path, glob или pattern." } : {}),
      ...(skipped.binary || skipped.large || skipped.secret ? { skipped } : {}),
      ...(found.length || truncated ? {} : { hint: "Совпадений нет. Проверьте pattern/glob или поищите другое слово." }),
    };
  },
});

/**
 * Карта файла по символам. Модель, которой нужна одна функция, больше не читает весь файл
 * целиком: `fs.outline` отдаёт строки и сигнатуры, а `name` — ещё и тело выбранного символа.
 */
type OutlineSymbol = { kind: string; name: string; line: number; signature?: string; exported?: boolean; container?: string };

type BraceScanState = { blockComment: boolean; quote: string | null; escaped: boolean; parens: number };

/**
 * Скобки вне строк и комментариев: по ним считается конец функции или класса. Скобки внутри
 * параметров (`options = {}`) не меняют вложенность — иначе сигнатура метода с объектом по
 * умолчанию выглядела бы как уже открытое и закрытое тело функции.
 */
function braceDelta(line: string, state: BraceScanState) {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (state.blockComment) {
      if (char === "*" && line[i + 1] === "/") {
        state.blockComment = false;
        i++;
      }
      continue;
    }
    if (state.quote) {
      if (state.escaped) state.escaped = false;
      else if (char === "\\") state.escaped = true;
      else if (char === state.quote) state.quote = null;
      continue;
    }
    if (char === "/" && line[i + 1] === "/") break;
    if (char === "/" && line[i + 1] === "*") {
      state.blockComment = true;
      i++;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      state.quote = char;
      continue;
    }
    if (char === "(") {
      state.parens++;
      continue;
    }
    if (char === ")") {
      state.parens = Math.max(0, state.parens - 1);
      continue;
    }
    if (state.parens > 0) continue;
    if (char === "{") delta++;
    else if (char === "}") delta--;
  }
  return delta;
}

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const JS_TOP_PATTERNS: Array<{ kind: string; expression: RegExp }> = [
  { kind: "function", expression: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/ },
  { kind: "class", expression: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "interface", expression: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "type", expression: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: "enum", expression: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
  { kind: "const", expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/ },
  { kind: "function", expression: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/ },
];
const JS_METHOD_PATTERN = /^\s*(?:(?:public|private|protected|static|readonly|override|async|get|set|declare|abstract)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^={]+)?\{/;
const JS_CLASS_FIELD_PATTERN = /^\s*(?:(?:public|private|protected|static|readonly|override|declare)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const JS_SKIP_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "typeof", "do", "else", "await", "with"]);

function signatureOf(line: string) {
  return line.trim().replace(/\s+/g, " ").slice(0, 160);
}

function jsOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  const state: BraceScanState = { blockComment: false, quote: null, escaped: false, parens: 0 };
  let depth = 0;
  let classDepth = -1;
  let className = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const before = depth;
    depth += braceDelta(line, state);
    if (before === 0) {
      const anonymousDefault = /^\s*export\s+default\s+(?:async\s+)?function\s*\(/.test(line);
      if (anonymousDefault) {
        symbols.push({ kind: "function", name: "default", line: index + 1, signature: signatureOf(line), exported: true });
      } else {
        for (const { kind, expression } of JS_TOP_PATTERNS) {
          const match = line.match(expression);
          if (!match) continue;
          symbols.push({
            kind,
            name: match[1],
            line: index + 1,
            signature: signatureOf(line),
            ...(/^\s*export\b/.test(line) ? { exported: true } : {}),
          });
          if (kind === "class" && depth > before) {
            classDepth = depth;
            className = match[1];
          }
          break;
        }
      }
    } else if (classDepth > 0 && before === classDepth) {
      const method = line.match(JS_METHOD_PATTERN);
      const field = method ? null : line.match(JS_CLASS_FIELD_PATTERN);
      const name = method?.[1] ?? field?.[1];
      if (name && !JS_SKIP_NAMES.has(name)) {
        symbols.push({ kind: "method", name, container: className, line: index + 1, signature: signatureOf(line) });
      }
    }
    if (classDepth > 0 && depth < classDepth) {
      classDepth = -1;
      className = "";
    }
  }
  return symbols;
}

function pythonIndent(line: string) {
  return (line.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "    ").length;
}

function pythonOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  const classes: Array<{ name: string; indent: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = pythonIndent(line);
    while (classes.length && indent <= classes[classes.length - 1].indent) classes.pop();
    const classMatch = line.match(/^\s*class\s+([A-Za-z_]\w*)/);
    if (classMatch) {
      symbols.push({ kind: "class", name: classMatch[1], line: index + 1, signature: signatureOf(line) });
      classes.push({ name: classMatch[1], indent });
      continue;
    }
    const functionMatch = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (!functionMatch) continue;
    const container = classes.length ? classes.map(item => item.name).join(".") : undefined;
    symbols.push({
      kind: container ? "method" : "function",
      name: functionMatch[1],
      line: index + 1,
      signature: signatureOf(line),
      ...(container ? { container } : {}),
    });
  }
  return symbols;
}

/** Конец JS/TS-символа по балансу скобок; однострочные объявления заканчиваются на своей строке. */
function jsSymbolEnd(lines: string[], startIndex: number) {
  const state: BraceScanState = { blockComment: false, quote: null, escaped: false, parens: 0 };
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < Math.min(lines.length, startIndex + 600); index++) {
    depth += braceDelta(lines[index], state);
    if (depth > 0) opened = true;
    if (opened && depth <= 0) return index + 1;
    if (!opened && index - startIndex >= 12) return startIndex + 1;
  }
  return Math.min(lines.length, startIndex + 600);
}

function pythonSymbolEnd(lines: string[], startIndex: number) {
  const base = pythonIndent(lines[startIndex]);
  let last = startIndex;
  for (let index = startIndex + 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    if (pythonIndent(lines[index]) <= base) return last + 1;
    last = index;
  }
  return last + 1;
}

const OUTLINE_SOURCE_CHARS = 16000;

registerTool({
  name: "fs.outline",
  description: "Map a JS/TS or Python file by symbols without reading it whole. Input: {path:string,name?:string}. Returns functions, classes, methods, interfaces, types and exported consts with line numbers and signatures. Pass `name` (for example `buildSession`) to get that symbol's full source instead of the map.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", description: "Путь к файлу внутри проекта" },
      name: { type: "string", description: "Имя функции, класса или метода; вернуть его код вместо карты файла" },
    },
  },
  execute: async (input, context) => {
    const value = input as { path?: string; name?: string };
    if (!value.path) throw new Error("не указан путь");
    assertNotSecretProjectPath(value.path, "читать");
    const sandbox = await getSandbox(context.projectId, context.userId);
    const bytes = await readFileBytesInside(sandbox.root, path.join(sandbox.root, value.path));
    if (looksBinary(bytes)) throw new Error("файл двоичный — карта символов не строится");
    const content = bytes.toString("utf8");
    if (content.length > 2_000_000) throw new Error("файл больше 2 МБ — карта символов не строится; используйте fs.grep и fs.read окнами");
    const lines = content.split(/\r?\n/);
    const extension = path.extname(value.path).toLowerCase();
    const language = JS_EXTENSIONS.has(extension) ? extension.slice(1) : extension === ".py" ? "python" : "";
    if (!language) {
      return {
        path: value.path,
        supported: false,
        language: extension.slice(1) || "unknown",
        hint: "Карта символов построена для JS/TS и Python. Для остальных файлов используйте fs.grep и fs.read.",
      };
    }
    const symbols = language === "python" ? pythonOutline(lines) : jsOutline(lines);
    const imports = [...new Set(Array.from(content.matchAll(/^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm), match => match[1]))].slice(0, 30);
    if (!symbols.length) {
      return { path: value.path, language, lines: lines.length, symbols: [], ...(imports.length ? { imports } : {}), hint: "Символы не найдены — возможно, файл состоит из выражений; используйте fs.read." };
    }
    if (value.name) {
      const query = value.name.trim().replace(/\(\)$/, "");
      const exact = symbols.filter(symbol => symbol.name === query || (symbol.container ? symbol.container + "." + symbol.name === query : false));
      const lowered = query.toLowerCase();
      const selected = exact.length ? exact : symbols.filter(symbol => symbol.name.toLowerCase().includes(lowered) || (symbol.container ? (symbol.container + "." + symbol.name).toLowerCase().includes(lowered) : false));
      if (!selected.length) {
        const available = symbols.slice(0, 25).map(symbol => (symbol.container ? symbol.container + "." : "") + symbol.name).join(", ");
        throw new Error("Символ «" + query + "» не найден. В файле: " + available + (symbols.length > 25 ? "…" : ""));
      }
      return {
        path: value.path,
        language,
        symbols: selected.map(symbol => {
          const start = symbol.line - 1;
          const end = language === "python" ? pythonSymbolEnd(lines, start) : jsSymbolEnd(lines, start);
          const source = lines.slice(start, end).join("\n");
          return {
            kind: symbol.kind,
            name: symbol.name,
            ...(symbol.container ? { container: symbol.container } : {}),
            line: symbol.line,
            endLine: end,
            source: source.length > OUTLINE_SOURCE_CHARS ? source.slice(0, OUTLINE_SOURCE_CHARS) + "\n…[символ сокращён: " + source.length + " символов]" : source,
          };
        }),
      };
    }
    return {
      path: value.path,
      language,
      lines: lines.length,
      symbols: symbols.slice(0, 200),
      ...(symbols.length > 200 ? { truncated: true } : {}),
      ...(imports.length ? { imports } : {}),
    };
  },
});
