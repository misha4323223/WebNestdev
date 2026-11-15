import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { IGNORED_PROJECT_DIRS } from "../../project-ignore.js";
import { isSecretProjectPath } from "../../secrets/secret-paths.js";
import { DEFAULT_REPO_INDEX_LIMITS, type RepoIndexLimits, type RepoIndexStats } from "./types.js";

/**
 * Files that can teach the agent something about the project's structure. Images, fonts, archives
 * and media are not read at all: an index of binary names is not worth the walk or the cache.
 */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi", ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".json", ".jsonc", ".md", ".mdx", ".yml", ".yaml", ".toml",
  ".sql", ".sh", ".bash", ".zsh", ".prisma", ".vue", ".svelte", ".astro",
  ".graphql", ".gql", ".xml",
]);
const TEXT_FILENAMES = new Set([
  "Dockerfile", "Makefile", "Procfile", "LICENSE", "README", "CHANGELOG", "AGENTS.md",
  "WEBNEST.md", ".gitignore", ".dockerignore", ".env.example", ".env.sample", ".env.template",
]);
const SKIP_FILENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "composer.lock", "Cargo.lock", "Gemfile.lock", ".DS_Store",
]);
const MAX_DEPTH = 24;

export type ScannedFile = {
  path: string;
  absolute: string;
  name: string;
  extension: string;
  size: number;
  mtimeMs: number;
};

export type ScanResult = {
  files: ScannedFile[];
  fingerprint: string;
  stats: RepoIndexStats;
  limits: RepoIndexLimits;
};

function isTextCandidate(name: string, extension: string) {
  if (SKIP_FILENAMES.has(name)) return false;
  if (TEXT_FILENAMES.has(name)) return true;
  return TEXT_EXTENSIONS.has(extension);
}

function normalizeRelative(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Walks the project once and returns only metadata. Reading and parsing happen later, after the
 * cache check: a cache hit must not pay for opening every source file.
 *
 * Symlinks are not followed at all. The sandbox path guard would refuse to read through them on
 * Linux, and following one during a walk could leave the project entirely.
 */
export async function scanProject(root: string, options: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {}): Promise<ScanResult> {
  const limits: RepoIndexLimits = {
    maxFiles: Math.max(1, Math.floor(options.maxFiles ?? DEFAULT_REPO_INDEX_LIMITS.maxFiles)),
    maxFileBytes: Math.max(1, Math.floor(options.maxFileBytes ?? DEFAULT_REPO_INDEX_LIMITS.maxFileBytes)),
    maxTotalBytes: Math.max(1, Math.floor(options.maxTotalBytes ?? DEFAULT_REPO_INDEX_LIMITS.maxTotalBytes)),
  };
  const files: ScannedFile[] = [];
  const stats: RepoIndexStats = {
    files: 0,
    sourceFiles: 0,
    textFiles: 0,
    truncated: false,
    skipped: { dirs: 0, binary: 0, large: 0, secret: 0, symlink: 0, unsupported: 0 },
  };
  const stack: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: root, relative: "", depth: 0 },
  ];
  let totalBytes = 0;

  outer: while (stack.length) {
    if (files.length >= limits.maxFiles) {
      stats.truncated = true;
      break;
    }
    const dir = stack.pop() as { absolute: string; relative: string; depth: number };
    if (dir.depth > MAX_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(dir.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: Array<{ absolute: string; relative: string; depth: number }> = [];
    for (const entry of entries) {
      if (files.length >= limits.maxFiles) {
        stats.truncated = true;
        break;
      }
      const relative = normalizeRelative(dir.relative ? dir.relative + "/" + entry.name : entry.name);
      if (entry.isSymbolicLink()) {
        stats.skipped.symlink++;
        continue;
      }
      if (isSecretProjectPath(relative)) {
        stats.skipped.secret++;
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_PROJECT_DIRS.has(entry.name)) {
          stats.skipped.dirs++;
          continue;
        }
        subdirs.push({
          absolute: path.join(dir.absolute, entry.name),
          relative,
          depth: dir.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!isTextCandidate(entry.name, extension)) {
        stats.skipped.unsupported++;
        continue;
      }
      let info;
      try {
        info = await lstat(path.join(dir.absolute, entry.name));
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > limits.maxFileBytes || totalBytes + info.size > limits.maxTotalBytes) {
        stats.skipped.large++;
        if (totalBytes + info.size > limits.maxTotalBytes) {
          stats.truncated = true;
          break outer;
        }
        continue;
      }
      totalBytes += info.size;
      files.push({
        path: relative,
        absolute: path.join(dir.absolute, entry.name),
        name: entry.name,
        extension,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
    // Reverse so the stack pops alphabetically, matching the other project walkers.
    stack.push(...subdirs.reverse());
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  stats.files = files.length;
  stats.textFiles = files.length;
  stats.sourceFiles = files.filter(file => [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py"].includes(file.extension)).length;
  const hash = createHash("sha1");
  hash.update("v1\0" + limits.maxFiles + "\0" + limits.maxFileBytes + "\0" + limits.maxTotalBytes + "\0" + (stats.truncated ? "1" : "0") + "\0");
  for (const file of files) {
    hash.update(file.path + "\0" + file.size + "\0" + Math.floor(file.mtimeMs) + "\0");
  }
  return { files, fingerprint: hash.digest("hex"), stats, limits };
}
