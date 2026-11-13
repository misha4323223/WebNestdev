import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { indexFileExists, staticOutputCandidates } from "./static-plan.js";
import {
  readPreviewProfile,
  writePreviewProfile,
  type HybridConfig,
  type PackageJson,
} from "./hybrid-config.js";

/**
 * Conservative hybrid discovery. It exists to turn an obvious split frontend/backend project
 * into a local profile without changing package.json. It deliberately does not guess from a
 * generic `start`/`dev`: a project that only has one combined command stays on the container
 * preview, where the command is already the source of truth.
 *
 * The detector is only a candidate producer. The actual start still builds the frontend, starts
 * the backend and verifies both. A transient failure is reported instead of silently replacing
 * hybrid with a dev container; an architectural mismatch may use the container fallback.
 */

const BACKEND_SCRIPT_NAMES = [
  "start:preview-api",
  "start:preview-server",
  "start:server",
  "start:api",
  "start:backend",
  "dev:server",
  "dev:api",
  "dev:backend",
  "server:dev",
  "api:dev",
  "backend:dev",
  "serve:server",
  "serve:api",
  "serve:backend",
  "backend:start",
  "backend:serve",
  "api:start",
  "api:serve",
  "server:start",
  "preview-api",
  "preview-server",
  "backend",
  "api",
  "server",
];
const SERVER_COMMAND = /(^|[\s;&|])(node|tsx|ts-node|nodemon|deno|bun)\b|(npm|pnpm|yarn)\s+(run\s+)?(start|serve|preview|dev|server|api|backend)\b/;
const STATIC_FRAMEWORKS = new Set([
  "vite",
  "@vitejs/plugin-react",
  "astro",
  "react-scripts",
  "parcel",
  "webpack",
  "rollup",
  "esbuild",
  "preact-cli",
]);
/** Frameworks whose normal output is produced by their own server, not a static split. */
const WHOLE_APP_FRAMEWORKS = new Set(["next", "nuxt", "remix", "@remix-run/node"]);
const BACKEND_PATH_PREFIXES = ["/api", "/ws", "/graphql", "/trpc", "/socket.io"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".webnestdev", "dist", "build", "out", ".next", ".nuxt", ".output",
  ".cache", ".parcel-cache", ".turbo", ".vite", "coverage", ".nyc_output", ".venv", "venv",
  "__pycache__", ".python", "public", "test", "tests", "__tests__", "spec", "e2e", "docs", "examples",
]);
const MAX_SOURCE_FILES = 800;
const MAX_SOURCE_BYTES = 128 * 1024;

export type HybridDetection =
  | { kind: "candidate"; config: HybridConfig; evidence: string[] }
  | { kind: "none"; reasons: string[] };

export type HybridProfileResult =
  | { kind: "configured"; config: HybridConfig; evidence: string[]; saved: boolean }
  | { kind: "none"; reasons: string[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackage(root: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

function scriptsOf(pkg: PackageJson): Record<string, string> {
  return isObject(pkg.scripts) ? (pkg.scripts as Record<string, string>) : {};
}

function dependenciesOf(pkg: PackageJson): Record<string, string> {
  return { ...(isObject(pkg.dependencies) ? pkg.dependencies : {}), ...(isObject(pkg.devDependencies) ? pkg.devDependencies : {}) };
}

function relativeDir(root: string, dir: string): string | null {
  const relative = path.relative(root, dir);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
  return relative;
}

function hasServerCommand(command: string): boolean {
  return SERVER_COMMAND.test(command);
}

function chooseBackendScript(scripts: Record<string, string>): { name: string; command: string } | null {
  for (const name of BACKEND_SCRIPT_NAMES) {
    const command = scripts[name]?.trim() ?? "";
    if (command && hasServerCommand(command)) return { name, command };
  }
  return null;
}

function defaultStaticDir(framework: string): string {
  return framework === "react-scripts" ? "build" : "dist";
}

function containsPath(text: string, prefix: string): boolean {
  for (const quote of ["\"", "'", "`"]) {
    if (text.includes(quote + prefix + quote) || text.includes(quote + prefix + "/")) return true;
    if (text.includes(quote + prefix + "?") || text.includes(quote + prefix + "#")) return true;
  }
  return false;
}

async function sourceFiles(root: string, budget = { files: 0 }): Promise<Array<{ path: string; text: string }>> {
  const found: Array<{ path: string; text: string }> = [];
  const stack = [root];
  while (stack.length && budget.files < MAX_SOURCE_FILES) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (budget.files >= MAX_SOURCE_FILES) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile() || info.size > MAX_SOURCE_BYTES) continue;
      const text = await readFile(full, "utf8").catch(() => "");
      if (!text) continue;
      budget.files += 1;
      found.push({ path: path.relative(root, full), text });
    }
  }
  return found;
}

async function detectBackendPaths(root: string): Promise<{ paths: string[]; evidence: string[] }> {
  const files = await sourceFiles(root);
  const paths: string[] = [];
  const evidence: string[] = [];
  for (const prefix of BACKEND_PATH_PREFIXES) {
    const hit = files.find(file => containsPath(file.text, prefix));
    if (!hit) continue;
    paths.push(prefix);
    evidence.push("source " + hit.path + " содержит " + prefix);
  }
  return { paths, evidence };
}

/**
 * Detect only the obvious case:
 * - package.json has a build script;
 * - there is a static frontend output or a known static framework;
 * - there is a dedicated backend npm script whose command starts a process;
 * - source code mentions at least one backend prefix (`/api`, `/ws`, ...);
 * - the project does not already declare its own preview contract or use a whole-app server
 *   framework such as Next/Nuxt/Remix.
 */
export async function detectHybridCandidate(root: string): Promise<HybridDetection> {
  const pkg = await readPackage(root);
  if (!pkg) return { kind: "none", reasons: ["в корне нет package.json или он некорректный"] };
  if (pkg.preview !== undefined) {
    return { kind: "none", reasons: ["package.json уже объявляет свой preview-контракт"] };
  }
  const scripts = scriptsOf(pkg);
  const deps = dependenciesOf(pkg);
  const buildScript = scripts.build?.trim() ?? "";
  if (!buildScript) return { kind: "none", reasons: ["нет scripts.build"] };

  const wholeApp = [...WHOLE_APP_FRAMEWORKS].find(name => deps[name]);
  if (wholeApp) return { kind: "none", reasons: ["whole-app framework " + wholeApp + " не делится на статику и backend автоматически"] };

  const backend = chooseBackendScript(scripts);
  if (!backend) return { kind: "none", reasons: ["нет отдельного backend-скрипта с явным именем"] };

  const framework = [...STATIC_FRAMEWORKS].find(name => deps[name]) ?? "";
  const output = (await Promise.all(staticOutputCandidates(root).map(async dir => ({ dir, exists: await indexFileExists(dir) })))).find(item => item.exists);
  if (!output && !framework) return { kind: "none", reasons: ["нет ни готового index.html, ни известного статического framework"] };
  const staticDir = output ? relativeDir(root, output.dir) : defaultStaticDir(framework);
  if (!staticDir) return { kind: "none", reasons: ["каталог сборки оказался вне проекта"] };

  const backendPaths = await detectBackendPaths(root);
  if (!backendPaths.paths.length) {
    return { kind: "none", reasons: ["в исходниках не найден ни один backend-префикс (/api, /ws, ...)"] };
  }

  return {
    kind: "candidate",
    config: {
      buildScript: "build",
      staticDir,
      backendScript: backend.name,
      backendPaths: backendPaths.paths,
      backendPort: 3000,
      backendEnv: {},
    },
    evidence: [
      "scripts.build: " + buildScript,
      "scripts." + backend.name + ": " + backend.command,
      ...(framework ? ["static framework: " + framework] : []),
      ...backendPaths.evidence,
    ],
  };
}

/**
 * Detect and persist a profile. An existing valid profile is reused; an invalid one is
 * regenerated only when the detector has a full, confident candidate.
 */
export async function detectAndSaveHybridProfile(root: string, savedBy: "server" | "agent" = "server"): Promise<HybridProfileResult> {
  const pkg = await readPackage(root);
  if (pkg?.preview !== undefined) {
    return { kind: "none", reasons: ["package.json уже объявляет свой preview-контракт"] };
  }
  const existing = await readPreviewProfile(root);
  if (existing.kind === "configured") {
    return { kind: "configured", config: existing.config, evidence: [], saved: false };
  }
  const detected = await detectHybridCandidate(root);
  if (detected.kind !== "candidate") return detected;
  await writePreviewProfile(root, detected.config, detected.evidence, savedBy);
  return { kind: "configured", config: detected.config, evidence: detected.evidence, saved: true };
}
