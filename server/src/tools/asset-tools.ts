import { lstat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { listInside, readFileBytesInside } from "../sandbox/path-guard.js";
import { looksBinary } from "../sandbox/binary.js";
import { isIgnoredProjectDir } from "../project-ignore.js";
import { registerTool } from "../tool-registry.js";

/**
 * `project.assets` — поиск мёртвых ассетов.
 *
 * Задача не в том, чтобы угадать каждый динамический путь, а в том, чтобы быстро назвать файлы,
 * на которые нет ни одной literal-ссылки. Поэтому проверка намеренно консервативная: она ищет
 * имя файла и путь без `public/` в текстовых исходниках и прямо предупреждает, что путь,
 * собранный из переменных, может выглядеть мёртвым. Лучше показать кандидатов с оговоркой, чем
 * удалить живой файл.
 */

const ASSET_DIRS = ["public", "uploads", "src/assets", "assets"];
const ASSET_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|avif|ico|bmp|mp4|webm|mov|mp3|wav|ogg|woff2?|ttf|otf)$/i;
const SOURCE_EXTENSIONS = /\.(html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro|md|json|yml|yaml)$/i;
const MAX_ASSETS = 300;
const MAX_SOURCE_FILES = 2500;
const MAX_SOURCE_BYTES = 1_000_000;

type AssetFile = { path: string; bytes: number };
type SourceFile = { path: string; text: string };

async function walkFiles(root: string, relative: string, options: {
  skipAssetDirs: boolean;
  limit: number;
  accept: (relative: string) => boolean;
}, result: string[]) {
  if (result.length >= options.limit) return;
  let entries;
  try {
    entries = await listInside(root, path.join(root, relative || "."));
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (result.length >= options.limit) return;
    const child = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (isIgnoredProjectDir(entry.name)) continue;
      if (options.skipAssetDirs && ASSET_DIRS.some(dir => child === dir || child.startsWith(dir + "/"))) continue;
      await walkFiles(root, child, options, result);
    } else if (entry.isFile() && options.accept(child)) {
      result.push(child);
    }
  }
}

async function readSource(root: string, relative: string): Promise<SourceFile | null> {
  const info = await lstat(path.join(root, relative)).catch(() => null);
  if (!info?.isFile() || info.size > MAX_SOURCE_BYTES) return null;
  const bytes = await readFileBytesInside(root, path.join(root, relative)).catch(() => null);
  if (!bytes || looksBinary(bytes)) return null;
  return { path: relative, text: bytes.toString("utf8") };
}

export type AssetAudit = {
  assets: number;
  sourceFiles: number;
  unused: AssetFile[];
  unusedBytes: number;
  totalBytes: number;
  truncated: boolean;
  note: string;
};

/** Чистая часть для тестов: корень проекта уже известен, песочница не нужна. */
export async function auditAssets(root: string): Promise<AssetAudit> {
  const assetPaths: string[] = [];
  for (const relative of ASSET_DIRS) {
    await walkFiles(root, relative, {
      skipAssetDirs: false,
      limit: MAX_ASSETS,
      accept: file => ASSET_EXTENSIONS.test(file),
    }, assetPaths);
    if (assetPaths.length >= MAX_ASSETS) break;
  }

  const sourcePaths: string[] = [];
  await walkFiles(root, "", {
    skipAssetDirs: true,
    limit: MAX_SOURCE_FILES,
    accept: file => SOURCE_EXTENSIONS.test(file) && !ASSET_EXTENSIONS.test(file),
  }, sourcePaths);

  const sources: string[] = [];
  for (const relative of sourcePaths) {
    const source = await readSource(root, relative);
    if (source) sources.push(source.text);
  }

  const assets: AssetFile[] = [];
  for (const relative of assetPaths) {
    const info = await lstat(path.join(root, relative)).catch(() => null);
    if (info?.isFile()) assets.push({ path: relative, bytes: info.size });
  }

  const unused: AssetFile[] = [];
  for (const asset of assets) {
    const withoutPublic = asset.path.replace(/^public\//, "");
    const basename = path.posix.basename(asset.path);
    const referenced = sources.some(text => text.includes(asset.path) || text.includes(withoutPublic) || text.includes(basename));
    if (!referenced) unused.push(asset);
  }
  unused.sort((left, right) => right.bytes - left.bytes);

  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const unusedBytes = unused.reduce((sum, asset) => sum + asset.bytes, 0);
  return {
    assets: assets.length,
    sourceFiles: sources.length,
    unused,
    unusedBytes,
    totalBytes,
    truncated: assetPaths.length >= MAX_ASSETS || sourcePaths.length >= MAX_SOURCE_FILES,
    note: "Проверяются literal-ссылки в текстовых исходниках. Путь, собранный из переменных, может выглядеть мёртвым: перед удалением проверьте такой файл вручную.",
  };
}

registerTool({
  name: "project.assets",
  description:
    "Find project assets that no text source references literally. Scans public/, uploads/, src/assets/ and assets/ for images, fonts, audio and video, then searches HTML/CSS/JS/TS/Vue/Svelte sources for the file path or basename. Returns {assets, sourceFiles, unused:[{path,bytes}], unusedBytes, totalBytes} and a warning that dynamically built paths can be false positives. Use it for cleanup, never delete a file only because this tool names it without checking dynamic references.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  execute: async (_input, context) => {
    const sandbox = await getSandbox(context.projectId, context.userId);
    const audit = await auditAssets(sandbox.root);
    return {
      ok: true,
      ...audit,
      ...(audit.unused.length
        ? { hint: "Начните с самых больших файлов; перед удалением проверьте, не строится ли путь динамически." }
        : { hint: "Мёртвых ассетов по literal-ссылкам нет." }),
    };
  },
});
