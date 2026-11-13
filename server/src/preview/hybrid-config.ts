import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureServiceExcludes } from "../changes/git-repo.js";

/**
 * Explicit hybrid-preview configuration from the project's package.json, or from the
 * platform-local `.webnestdev/preview.json` created by the detector.
 *
 * The local profile is deliberately not part of the repository contract: it lets the platform
 * remember a safe hybrid split without changing a user's package.json or sending service files
 * to git. `.webnestdev/` is already excluded through `.git/info/exclude` by git-repo.ts.
 */

const DEFAULT_BUILD_SCRIPT = "build";
const DEFAULT_STATIC_DIR = "dist";
const DEFAULT_BACKEND_PATHS = ["/api"];
const DEFAULT_BACKEND_PORT = 3000;
const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROFILE_VERSION = 1;

export const PREVIEW_PROFILE_DIR = ".webnestdev";
export const PREVIEW_PROFILE_FILE = "preview.json";
export const PREVIEW_PROFILE_PATH = path.posix.join(PREVIEW_PROFILE_DIR, PREVIEW_PROFILE_FILE);

export type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  preview?: unknown;
};

export type HybridConfig = {
  /** npm script that builds the project, and with it the static output and backend. */
  buildScript: string;
  /** Output directory, relative to the project root. */
  staticDir: string;
  /** npm script that starts the backend. */
  backendScript: string;
  /** Path prefixes routed to the backend; `/api` by default. */
  backendPaths: string[];
  /** Port the backend is expected to listen on inside its container. */
  backendPort: number;
  /** Non-secret environment values for the backend process. */
  backendEnv: Record<string, string>;
  /** What to do when hybrid cannot start. Default is `auto`: fall back only for an architecture mismatch. */
  fallback?: "auto" | "none" | "container";
};

export type HybridConfigRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "configured"; config: HybridConfig };

type PackageRead = { ok: true; pkg: PackageJson } | { ok: false; reason: "missing" | "invalid" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeInside(root: string, value: string): string | null {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
  return resolved;
}

function normalizePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed === "/" || trimmed.includes("?") || trimmed.includes("#")) return null;
  const normalized = path.posix.normalize(trimmed);
  if (normalized !== trimmed || normalized === "/" || normalized.startsWith("/../")) return null;
  return normalized.replace(/\/+$/, "");
}

async function readPackage(root: string): Promise<PackageRead> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    return { ok: true, pkg: JSON.parse(raw) as PackageJson };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function scriptsOf(pkg: PackageJson): Record<string, string> {
  return isObject(pkg.scripts) ? (pkg.scripts as Record<string, string>) : {};
}

/**
 * Validate the common hybrid contract used by both package.json.preview and the local profile.
 * Keeping one validator means the server cannot accept a profile the agent could not write.
 */
export function validateHybridPreview(
  root: string,
  preview: unknown,
  scripts: Record<string, string>,
): HybridConfigRead {
  if (!isObject(preview) || preview.mode !== "hybrid") return { kind: "absent" };

  const fallbackValue = preview.fallback;
  if (fallbackValue !== undefined && fallbackValue !== "auto" && fallbackValue !== "none" && fallbackValue !== "container") {
    return { kind: "invalid", reason: "preview.fallback должен быть auto, none или container." };
  }
  const fallback = fallbackValue === "container" ? "container" : fallbackValue === "none" ? "none" : "auto";

  const backend = preview.backend;
  if (typeof backend !== "string" || !backend.trim()) {
    return { kind: "invalid", reason: "Для hybrid в package.json.preview.backend нужен npm-скрипт запуска backend." };
  }
  const backendScript = backend.trim();
  if (!SCRIPT_NAME.test(backendScript)) {
    return { kind: "invalid", reason: "package.json.preview.backend должен быть именем npm-скрипта, а не shell-командой." };
  }
  if (typeof scripts[backendScript] !== "string" || !scripts[backendScript].trim()) {
    return { kind: "invalid", reason: "В package.json нет скрипта " + backendScript + " для backend hybrid-предпросмотра." };
  }

  const buildValue = preview.build;
  const buildScript = typeof buildValue === "string" ? buildValue.trim() : DEFAULT_BUILD_SCRIPT;
  if (!SCRIPT_NAME.test(buildScript)) {
    return { kind: "invalid", reason: "package.json.preview.build должен быть именем npm-скрипта." };
  }
  if (typeof scripts[buildScript] !== "string" || !scripts[buildScript].trim()) {
    return { kind: "invalid", reason: "В package.json нет скрипта " + buildScript + " для сборки hybrid-предпросмотра." };
  }

  const staticValue = preview.staticDir;
  const staticDir = typeof staticValue === "string" ? staticValue.trim() : DEFAULT_STATIC_DIR;
  if (!relativeInside(root, staticDir)) {
    return { kind: "invalid", reason: "package.json.preview.staticDir должен быть каталогом внутри проекта." };
  }

  const pathsValue = preview.backendPaths;
  if (pathsValue !== undefined && !Array.isArray(pathsValue)) {
    return { kind: "invalid", reason: "package.json.preview.backendPaths должен быть массивом путей." };
  }
  const rawPaths = pathsValue === undefined ? DEFAULT_BACKEND_PATHS : pathsValue;
  const backendPaths: string[] = [];
  for (const item of rawPaths) {
    if (typeof item !== "string") {
      return { kind: "invalid", reason: "package.json.preview.backendPaths должен содержать только строки." };
    }
    const normalized = normalizePath(item);
    if (!normalized) {
      return { kind: "invalid", reason: "Некорректный backend path " + JSON.stringify(item) + ": нужен префикс вида /api." };
    }
    if (!backendPaths.includes(normalized)) backendPaths.push(normalized);
  }

  const portValue = preview.backendPort;
  const backendPort = portValue === undefined ? DEFAULT_BACKEND_PORT : Number(portValue);
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535) {
    return { kind: "invalid", reason: "package.json.preview.backendPort должен быть портом от 1 до 65535." };
  }

  const envValue = preview.backendEnv;
  const backendEnv: Record<string, string> = {};
  if (envValue !== undefined) {
    if (!isObject(envValue)) {
      return { kind: "invalid", reason: "package.json.preview.backendEnv должен быть объектом строк." };
    }
    for (const [name, value] of Object.entries(envValue)) {
      if (!ENV_NAME.test(name) || typeof value !== "string") {
        return { kind: "invalid", reason: "package.json.preview.backendEnv содержит некорректную переменную." };
      }
      backendEnv[name] = value;
    }
  }

  return {
    kind: "configured",
    config: {
      buildScript,
      staticDir,
      backendScript,
      backendPaths,
      backendPort,
      backendEnv,
      fallback,
    },
  };
}

/**
 * The local profile is a platform service file, never executable evidence of its own. It is
 * validated against the project's package.json scripts before the server will trust it.
 */
export async function readPreviewProfile(root: string): Promise<HybridConfigRead> {
  const packageRead = await readPackage(root);
  if (!packageRead.ok) {
    return packageRead.reason === "missing" ? { kind: "absent" } : { kind: "invalid", reason: "В package.json проекта некорректный JSON." };
  }
  let raw: string;
  try {
    raw = await readFile(path.join(root, PREVIEW_PROFILE_DIR, PREVIEW_PROFILE_FILE), "utf8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "В " + PREVIEW_PROFILE_PATH + " некорректный JSON." };
  }
  if (!isObject(parsed)) return { kind: "invalid", reason: "В " + PREVIEW_PROFILE_PATH + " ожидается объект." };
  if (parsed.version !== undefined && parsed.version !== PROFILE_VERSION) {
    return { kind: "invalid", reason: "Версия " + PREVIEW_PROFILE_PATH + " не поддерживается." };
  }
  return validateHybridPreview(root, parsed, scriptsOf(packageRead.pkg));
}

/** Read the explicit package contract first, then the platform-local profile. */
export async function readHybridConfig(root: string): Promise<HybridConfigRead> {
  const packageRead = await readPackage(root);
  if (!packageRead.ok) {
    return packageRead.reason === "missing" ? { kind: "absent" } : { kind: "invalid", reason: "В package.json проекта некорректный JSON." };
  }
  const preview = packageRead.pkg.preview;
  if (preview !== undefined) {
    // An explicit package declaration always wins: a stale local profile must not override it.
    return validateHybridPreview(root, preview, scriptsOf(packageRead.pkg));
  }
  return readPreviewProfile(root);
}

/**
 * Save a detector result without touching package.json. The write is atomic and the local git
 * exclude is refreshed first, so `.webnestdev/` cannot be committed by a later checkpoint.
 */
export async function writePreviewProfile(
  root: string,
  config: HybridConfig,
  evidence: string[] = [],
  savedBy: "server" | "agent" = "server",
): Promise<HybridConfig> {
  const packageRead = await readPackage(root);
  if (!packageRead.ok) {
    throw new Error(packageRead.reason === "missing" ? "Для hybrid-профиля нужен package.json в корне проекта." : "В package.json проекта некорректный JSON.");
  }
  const checked = validateHybridPreview(root, {
    mode: "hybrid",
    build: config.buildScript,
    staticDir: config.staticDir,
    backend: config.backendScript,
    backendPaths: config.backendPaths,
    backendPort: config.backendPort,
    backendEnv: config.backendEnv,
    fallback: config.fallback,
  }, scriptsOf(packageRead.pkg));
  if (checked.kind !== "configured") {
    throw new Error(checked.kind === "invalid" ? checked.reason : "Hybrid-профиль не прошёл проверку контракта.");
  }
  await ensureServiceExcludes(root);
  const dir = path.join(root, PREVIEW_PROFILE_DIR);
  const target = path.join(dir, PREVIEW_PROFILE_FILE);
  const payload = {
    version: PROFILE_VERSION,
    mode: "hybrid",
    build: checked.config.buildScript,
    staticDir: checked.config.staticDir,
    backend: checked.config.backendScript,
    backendPaths: checked.config.backendPaths,
    backendPort: checked.config.backendPort,
    backendEnv: checked.config.backendEnv,
    fallback: checked.config.fallback,
    savedBy,
    savedAt: new Date().toISOString(),
    evidence: evidence
      .filter(item => typeof item === "string" && item.trim())
      .slice(0, 20)
      .map(item => item.trim().slice(0, 300)),
  };
  await mkdir(dir, { recursive: true });
  const temporary = target + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  await rename(temporary, target);
  return checked.config;
}
