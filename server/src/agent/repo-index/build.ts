import path from "node:path";
import { readFileBytesInside, renameInside, writeFileInside } from "../../sandbox/path-guard.js";
import { looksBinary } from "../../sandbox/binary.js";
import { parseSource, isLocalSpecifier } from "./parse.js";
import { scanProject, type ScannedFile } from "./scan.js";
import {
  DEFAULT_REPO_INDEX_LIMITS,
  type RepoFile,
  type RepoImport,
  type RepoIndex,
  type RepoIndexOptions,
  type RepoPackage,
} from "./types.js";

const CACHE_DIR = ".webnestdev";
const CACHE_FILE = "repo-index.json";
const CACHE_VERSION = 1;
const MEMORY_TTL_MS = 15_000;
const RESOLVE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".vue", ".svelte", ".astro", ".py", ".json", ".css", ".scss", ".sass", ".less",
  ".html", ".htm",
];
const COMMON_ENTRY_POINTS = [
  "src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx",
  "app/page.tsx", "pages/index.tsx", "server/src/index.ts",
  "main.py", "app.py", "index.html", "public/index.html",
];

type AliasRule = { pattern: string; targets: string[] };
type ProjectConfig = { baseUrl: string; aliases: AliasRule[]; packages: RepoPackage[] };
type CacheEntry = { index: RepoIndex; at: number };

const memoryCache = new Map<string, CacheEntry>();

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function parseJsonLoose(value: string): unknown {
  const withoutComments = value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutComments);
}

async function readText(root: string, file: ScannedFile): Promise<string | undefined> {
  try {
    const bytes = await readFileBytesInside(root, file.absolute);
    if (looksBinary(bytes)) return undefined;
    return bytes.toString("utf8");
  } catch {
    return undefined;
  }
}

async function readProjectConfig(root: string, files: ScannedFile[]): Promise<ProjectConfig> {
  const byPath = new Map(files.map(file => [file.path, file]));
  let baseUrl = "";
  const aliases: AliasRule[] = [];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = byPath.get(name);
    if (!file) continue;
    const raw = await readText(root, file);
    if (!raw) continue;
    try {
      const config = parseJsonLoose(raw) as {
        compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> };
      };
      const options = config.compilerOptions;
      if (typeof options?.baseUrl === "string") baseUrl = normalize(options.baseUrl);
      for (const [pattern, targets] of Object.entries(options?.paths ?? {})) {
        if (!Array.isArray(targets)) continue;
        aliases.push({
          pattern,
          targets: targets.filter((target): target is string => typeof target === "string"),
        });
      }
    } catch {
      // A broken tsconfig is not a reason to lose the whole index; path aliases simply stay off.
    }
  }

  const packages: RepoPackage[] = [];
  for (const file of files) {
    if (file.name !== "package.json") continue;
    const raw = await readText(root, file);
    if (!raw) continue;
    try {
      const pkg = parseJsonLoose(raw) as {
        name?: unknown;
        main?: unknown;
        module?: unknown;
        source?: unknown;
      };
      if (typeof pkg.name !== "string" || !pkg.name.trim()) continue;
      const dir = normalize(path.posix.dirname(file.path));
      const entryName = [pkg.source, pkg.module, pkg.main].find((value): value is string => typeof value === "string" && value.trim().length > 0);
      const entry = entryName ? normalize(path.posix.join(dir === "." ? "" : dir, entryName)) : undefined;
      packages.push({
        name: pkg.name.trim(),
        dir: dir === "." ? "" : dir,
        ...(entry ? { entry } : {}),
      });
    } catch {
      // Invalid package.json is a project problem, not a reason to fail the map.
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return { baseUrl, aliases, packages };
}

function tryFile(files: Set<string>, candidate: string): string | undefined {
  const base = normalize(candidate);
  if (!base || base === ".") return undefined;
  if (files.has(base)) return base;
  for (const extension of RESOLVE_EXTENSIONS) {
    if (files.has(base + extension)) return base + extension;
  }
  // TypeScript projects often write `./foo.js` while the source is `foo.ts`.
  if (/\.(?:js|jsx|mjs|cjs)$/.test(base)) {
    const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
    for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(stem + extension)) return stem + extension;
    }
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    if (files.has(base + "/index" + extension)) return base + "/index" + extension;
  }
  if (files.has(base + "/__init__.py")) return base + "/__init__.py";
  return undefined;
}

function resolveAlias(specifier: string, config: ProjectConfig): string | undefined {
  for (const rule of config.aliases) {
    const star = rule.pattern.indexOf("*");
    let middle: string | undefined;
    if (star === -1) {
      if (specifier !== rule.pattern) continue;
      middle = "";
    } else {
      const prefix = rule.pattern.slice(0, star);
      const suffix = rule.pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of rule.targets) {
      const candidate = normalize(path.posix.join(config.baseUrl, target.replace("*", middle)));
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function resolvePackage(specifier: string, config: ProjectConfig): string | undefined {
  for (const pkg of config.packages) {
    if (specifier !== pkg.name && !specifier.startsWith(pkg.name + "/")) continue;
    if (specifier === pkg.name) return pkg.entry ?? normalize(path.posix.join(pkg.dir, "index"));
    const subpath = specifier.slice(pkg.name.length + 1);
    return normalize(path.posix.join(pkg.dir, subpath));
  }
  return undefined;
}

function resolvePython(from: string, specifier: string): string | undefined {
  const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
  if (!dots) {
    const modulePath = normalize(specifier.replaceAll(".", "/"));
    return modulePath || undefined;
  }
  let base = normalize(path.posix.dirname(from));
  for (let index = 1; index < dots; index++) base = normalize(path.posix.dirname(base));
  const rest = normalize(specifier.slice(dots).replaceAll(".", "/"));
  return rest ? normalize(path.posix.join(base, rest)) : base;
}

function resolveTarget(
  from: RepoFile,
  specifier: string,
  files: Set<string>,
  config: ProjectConfig,
): string | undefined {
  let candidate: string | undefined;
  if (from.language === "python" && specifier.startsWith(".")) {
    candidate = resolvePython(from.path, specifier);
  } else if (isLocalSpecifier(specifier)) {
    candidate = specifier.startsWith("/")
      ? normalize(specifier)
      : normalize(path.posix.join(path.posix.dirname(from.path), specifier));
  } else {
    candidate = resolveAlias(specifier, config) ?? resolvePackage(specifier, config);
    if (!candidate && from.language === "python") candidate = normalize(specifier.replaceAll(".", "/"));
  }
  return candidate ? tryFile(files, candidate) : undefined;
}

function entryPoints(files: Set<string>, config: ProjectConfig) {
  const result = new Set<string>();
  for (const pkg of config.packages) {
    if (pkg.entry && files.has(pkg.entry)) result.add(pkg.entry);
    // A package that publishes dist/ often keeps its source at src/index.ts; the built file is
    // ignored, but the source entry is still the best anchor for the agent.
    for (const name of ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "index.ts", "index.tsx", "main.py"]) {
      const candidate = normalize(path.posix.join(pkg.dir, name));
      if (files.has(candidate)) result.add(candidate);
    }
  }
  for (const candidate of COMMON_ENTRY_POINTS) {
    if (files.has(candidate)) result.add(candidate);
  }
  return [...result].sort();
}

function isTestFile(pathValue: string) {
  return /(?:^|\/)(?:__tests__|tests?)\//.test(pathValue)
    || /\.(?:test|spec)\.[^/]+$/.test(pathValue)
    || /(?:^|\/)test_[^/]+\.py$/.test(pathValue);
}

function normalizeStats(index: RepoIndex) {
  index.stats.files = index.files.length;
  index.stats.textFiles = index.files.length;
  index.stats.sourceFiles = index.files.filter(file => ["ts", "tsx", "js", "jsx", "python"].includes(file.language)).length;
}

function isRepoIndex(value: unknown): value is RepoIndex {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RepoIndex>;
  if (candidate.version !== CACHE_VERSION || typeof candidate.fingerprint !== "string") return false;
  if (!Array.isArray(candidate.files) || !Array.isArray(candidate.packages) || !Array.isArray(candidate.entryPoints) || !Array.isArray(candidate.tests)) return false;
  if (!candidate.limits || !candidate.stats) return false;
  return candidate.files.every(file => file
    && typeof file.path === "string"
    && typeof file.language === "string"
    && typeof file.bytes === "number"
    && typeof file.lines === "number"
    && Array.isArray(file.symbols)
    && file.symbols.every(symbol => typeof symbol === "string")
    && Array.isArray(file.imports)
    && file.imports.every(item => item && typeof item.specifier === "string" && typeof item.external === "boolean"));
}

async function readDiskCache(root: string): Promise<RepoIndex | undefined> {
  try {
    const bytes = await readFileBytesInside(root, path.join(root, CACHE_DIR, CACHE_FILE));
    // A cache is an optimisation; a gigantic or corrupt file must not become an unbounded read.
    if (bytes.length > 8 * 1024 * 1024) return undefined;
    const raw = bytes.toString("utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRepoIndex(parsed) && parsed.version === CACHE_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeDiskCache(root: string, index: RepoIndex) {
  const target = path.join(root, CACHE_DIR, CACHE_FILE);
  const temporary = path.join(root, CACHE_DIR, CACHE_FILE + "." + process.pid + "." + Date.now() + ".tmp");
  try {
    const raw = JSON.stringify(index) + "\n";
    // The reader refuses anything above 8 MB; writing a larger cache would only make every run
    // rebuild it. The in-memory map still serves the current process.
    if (raw.length > 8 * 1024 * 1024) return;
    await writeFileInside(root, temporary, raw);
    await renameInside(root, temporary, target);
  } catch {
    // The cache is an optimisation; a read-only or full disk must not fail the map.
    try { await renameInside(root, temporary, target); } catch {}
  }
}

/**
 * Build the index from a fresh scan. The disk cache is checked only after the scan, so a changed
 * file invalidates it; an unchanged project does not read or parse a single source file.
 */
export async function buildRepoIndex(root: string, options: RepoIndexOptions = {}): Promise<RepoIndex> {
  const scan = await scanProject(root, options);
  if (options.useDiskCache !== false && !options.refresh) {
    const cached = await readDiskCache(root);
    if (
      cached
      && cached.fingerprint === scan.fingerprint
      && cached.limits.maxFiles === scan.limits.maxFiles
      && cached.limits.maxFileBytes === scan.limits.maxFileBytes
      && cached.limits.maxTotalBytes === scan.limits.maxTotalBytes
    ) {
      return cached;
    }
  }

  const config = await readProjectConfig(root, scan.files);
  const knownFiles = new Set(scan.files.map(file => file.path));
  const indexed: RepoFile[] = [];
  for (const file of scan.files) {
    const content = await readText(root, file);
    if (content === undefined) {
      scan.stats.skipped.binary++;
      continue;
    }
    const parsed = parseSource(file.extension, content);
    indexed.push({
      path: file.path,
      language: parsed.language,
      bytes: Buffer.byteLength(content),
      lines: parsed.lines,
      imports: parsed.imports,
      symbols: parsed.symbols,
    });
  }
  for (const file of indexed) {
    file.imports = file.imports.map((item): RepoImport => {
      const target = resolveTarget(file, item.specifier, knownFiles, config);
      return {
        specifier: item.specifier,
        ...(target ? { target } : {}),
        external: item.external && !target && !isLocalSpecifier(item.specifier) && !resolveAlias(item.specifier, config) && !resolvePackage(item.specifier, config),
      };
    });
  }

  const index: RepoIndex = {
    version: CACHE_VERSION,
    generatedAt: new Date().toISOString(),
    fingerprint: scan.fingerprint,
    limits: scan.limits,
    files: indexed,
    packages: config.packages,
    entryPoints: entryPoints(knownFiles, config),
    tests: indexed.map(file => file.path).filter(isTestFile),
    stats: scan.stats,
  };
  normalizeStats(index);
  if (options.useDiskCache !== false) await writeDiskCache(root, index);
  return index;
}

function memoryKey(root: string, options: RepoIndexOptions) {
  return root + "\0" + (options.maxFiles ?? DEFAULT_REPO_INDEX_LIMITS.maxFiles) + "\0" + (options.maxFileBytes ?? DEFAULT_REPO_INDEX_LIMITS.maxFileBytes) + "\0" + (options.maxTotalBytes ?? DEFAULT_REPO_INDEX_LIMITS.maxTotalBytes);
}

/** Per-process cache with a short TTL: edits inside a run are picked up by the next orientation call. */
export async function getRepoIndex(root: string, options: RepoIndexOptions = {}): Promise<RepoIndex> {
  const key = memoryKey(root, options);
  const cached = memoryCache.get(key);
  if (!options.refresh && !options.verify && cached && Date.now() - cached.at < MEMORY_TTL_MS) return cached.index;
  const index = await buildRepoIndex(root, options);
  memoryCache.set(key, { index, at: Date.now() });
  while (memoryCache.size > 32) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
  return index;
}

export function invalidateRepoIndex(root: string) {
  for (const key of memoryCache.keys()) {
    if (key === root || key.startsWith(root + "\0")) memoryCache.delete(key);
  }
}

export { isTestFile };
