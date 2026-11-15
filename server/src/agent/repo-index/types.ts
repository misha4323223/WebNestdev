/**
 * The repository index is a compact, serialisable map of a project: source files, the imports
 * between them, symbols worth searching for, workspace packages and entry points.
 *
 * It deliberately contains no file contents. The model still reads exact code through `fs.read`;
 * the index only tells it where to look. That keeps the map small, cacheable and safe to send back
 * through a tool result.
 */
export type RepoLanguage = "ts" | "tsx" | "js" | "jsx" | "python" | "css" | "html" | "json" | "other";

export type RepoImport = {
  /** The specifier exactly as written, e.g. `./helper`, `@/lib/api`, `react`. */
  specifier: string;
  /** A project-relative path when the import was resolved locally; absent for external packages. */
  target?: string;
  /** True only for bare imports that no workspace package or path alias matched. */
  external: boolean;
};

export type RepoFile = {
  path: string;
  language: RepoLanguage;
  bytes: number;
  lines: number;
  imports: RepoImport[];
  /** Exported or top-level names; a hint for search, not a type checker. */
  symbols: string[];
};

export type RepoPackage = {
  name: string;
  dir: string;
  entry?: string;
};

export type RepoIndexStats = {
  files: number;
  sourceFiles: number;
  textFiles: number;
  truncated: boolean;
  skipped: {
    dirs: number;
    binary: number;
    large: number;
    secret: number;
    symlink: number;
    unsupported: number;
  };
};

export type RepoIndexLimits = {
  maxFiles: number;
  maxFileBytes: number;
  /** A project is not allowed to turn one orientation call into a multi-gigabyte read. */
  maxTotalBytes: number;
};

export type RepoIndex = {
  version: 1;
  generatedAt: string;
  /** Hash of the scanned paths, sizes and mtimes; a changed project never reuses a stale cache. */
  fingerprint: string;
  limits: RepoIndexLimits;
  files: RepoFile[];
  packages: RepoPackage[];
  entryPoints: string[];
  tests: string[];
  stats: RepoIndexStats;
};

export type RepoIndexOptions = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Ignore both caches and rebuild from the filesystem. */
  refresh?: boolean;
  /** Bypass the in-process cache but still use the disk cache when the fingerprint matches. */
  verify?: boolean;
  useDiskCache?: boolean;
};

export type RepoFindMatch = {
  path: string;
  score: number;
  reason: string;
  symbols: string[];
  imports: string[];
  dependents: string[];
};

export type RepoMapResult = {
  generatedAt: string;
  fingerprint: string;
  stats: RepoIndexStats;
  limits: RepoIndexLimits;
  languages: Record<string, number>;
  packages: RepoPackage[];
  entryPoints: string[];
  testFiles: number;
  topDirectories: Array<{ path: string; files: number }>;
  /** A short list of files to start from; not the whole map. */
  anchors: string[];
};

export const DEFAULT_REPO_INDEX_LIMITS: RepoIndexLimits = {
  maxFiles: 4000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};
