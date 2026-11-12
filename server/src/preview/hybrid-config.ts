import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Explicit hybrid-preview configuration from the project's package.json.
 *
 * Hybrid is never inferred from `dev`/`start` scripts. A project that wants it says so, names an
 * npm script that starts its backend, and lists the paths that belong to that backend. This
 * keeps ordinary node-runtime projects on the existing container preview and avoids sending
 * arbitrary commands into the sandbox.
 */

const DEFAULT_BUILD_SCRIPT = "build";
const DEFAULT_STATIC_DIR = "dist";
const DEFAULT_BACKEND_PATHS = ["/api"];
const DEFAULT_BACKEND_PORT = 3000;
const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type PackageJson = {
  scripts?: Record<string, string>;
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
};

export type HybridConfigRead =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | { kind: "configured"; config: HybridConfig };

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

export async function readHybridConfig(root: string): Promise<HybridConfigRead> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, "package.json"), "utf8");
  } catch {
    return { kind: "absent" };
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    return { kind: "invalid", reason: "В package.json проекта некорректный JSON." };
  }
  if (!isObject(pkg.preview) || pkg.preview.mode !== "hybrid") return { kind: "absent" };

  const scripts = isObject(pkg.scripts) ? pkg.scripts : {};
  const backend = pkg.preview.backend;
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

  const buildValue = pkg.preview.build;
  const buildScript = typeof buildValue === "string" ? buildValue.trim() : DEFAULT_BUILD_SCRIPT;
  if (!SCRIPT_NAME.test(buildScript)) {
    return { kind: "invalid", reason: "package.json.preview.build должен быть именем npm-скрипта." };
  }
  if (typeof scripts[buildScript] !== "string" || !scripts[buildScript].trim()) {
    return { kind: "invalid", reason: "В package.json нет скрипта " + buildScript + " для сборки hybrid-предпросмотра." };
  }

  const staticValue = pkg.preview.staticDir;
  const staticDir = typeof staticValue === "string" ? staticValue.trim() : DEFAULT_STATIC_DIR;
  if (!relativeInside(root, staticDir)) {
    return { kind: "invalid", reason: "package.json.preview.staticDir должен быть каталогом внутри проекта." };
  }

  const pathsValue = pkg.preview.backendPaths;
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

  const portValue = pkg.preview.backendPort;
  const backendPort = portValue === undefined ? DEFAULT_BACKEND_PORT : Number(portValue);
  if (!Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65_535) {
    return { kind: "invalid", reason: "package.json.preview.backendPort должен быть портом от 1 до 65535." };
  }

  const envValue = pkg.preview.backendEnv;
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
    },
  };
}
