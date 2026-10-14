import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * What kind of project this is — decided by structure, dependencies and commands together,
 * never by a single file. `package.json` alone proves nothing: it can describe a static site
 * with a build script or a long-running server, and the difference is a container or no
 * container at all, which on a small host is the difference between one user and a hundred.
 *
 * One rule is deliberately absolute: a `Dockerfile` in the project is **never executed**. A
 * build from a user's Dockerfile runs its steps as root without the memory, PID and network
 * limits that `docker run` applies, so it is not the same trust level as everything else here.
 * The file is reported as evidence and the project keeps being served by our own image; a
 * proper isolated builder is a separate product, not a flag.
 */

export type ProjectKind = "instant-site" | "static-build" | "node-runtime" | "python-runtime" | "unknown";

export type ProjectShape = {
  kind: ProjectKind;
  /** Russian, shown to the user in the preview panel — it is the answer to "почему так". */
  reason: string;
  /** The files that decided it, so the panel can show the evidence instead of a verdict. */
  evidence: string[];
  /** A Dockerfile is present; it is never run, and the panel says so. */
  userDockerfile: boolean;
};

/** Everything the decision needs, already read from disk — so the rules stay testable. */
export type ProjectFiles = {
  /** Root entry names, as `readdir` returns them. */
  entries: string[];
  packageJson?: (Record<string, unknown> & { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) | null;
  /** Text of the framework config files (next/vite/nuxt/astro/svelte), concatenated. */
  configText?: string;
  /** Text of the Python manifests (requirements.txt/pyproject.toml) if there are any. */
  pythonManifest?: string;
  /**
   * A ready `index.html`, as a path relative to the root (`index.html`, `dist/index.html`, …).
   * A directory listing cannot see inside `dist`, so the caller checks those candidates — and
   * its presence is what makes the cheapest tier possible: files that need no build at all.
   */
  staticEntry?: string;
};

/** Frameworks that answer HTTP themselves, so the project needs a running process, not files. */
const SERVER_PACKAGES = ["express", "fastify", "koa", "hono", "nest", "@nestjs/core", "socket.io", "ws", "hapi", "@hapi/hapi", "restify", "polka", "next", "nuxt", "remix", "@remix-run/node"];
/** Dev-server frameworks whose output is plain files: a build makes them static. */
const STATIC_PACKAGES = ["vite", "astro", "@sveltejs/kit", "parcel", "esbuild", "rollup", "webpack", "@angular/core", "preact-cli", "react-scripts"];
/** Python web frameworks: a requirements.txt with one of these means a service, not a page. */
const PYTHON_SERVER = ["fastapi", "flask", "django", "uvicorn", "gunicorn", "starlette", "aiohttp", "streamlit", "gradio", "tornado", "bottle"];
/**
 * Commands that start a long-running process rather than a one-shot build. `vite`, `astro` and
 * `react-scripts` are deliberately absent: their dev servers serve files this platform can serve
 * itself, so a build script is the better answer than a container.
 */
const SERVER_SCRIPT = /^\s*(node|tsx|ts-node|nodemon|next|nuxt|remix|uvicorn|gunicorn|python3?|streamlit|flask|deno|bun)\b/;

/** The script that would keep a process alive, if there is one. */
function startsServer(scripts: Record<string, string> | undefined) {
  for (const name of ["start", "serve", "dev"]) {
    const command = scripts?.[name]?.trim();
    if (command && SERVER_SCRIPT.test(command)) return name + ": " + command;
  }
  return "";
}

function hasAny(names: string[], entries: string[]) {
  return names.find(name => entries.includes(name)) ?? "";
}

function depsOf(files: ProjectFiles) {
  return { ...(files.packageJson?.dependencies ?? {}), ...(files.packageJson?.devDependencies ?? {}) };
}

/** Where a ready-to-serve `index.html` may already be, relative to the project root. */
export const STATIC_ENTRY_CANDIDATES = ["index.html", "dist/index.html", "build/index.html", "out/index.html", "public/index.html", "www/index.html", "site/index.html"];

/**
 * The rules, in the order they must be applied: a project that answers HTTP outranks one that
 * only builds files, and a project that builds files outranks a bare page. Getting this order
 * wrong is what would start a container for a page that needs none.
 */
export function classifyProject(files: ProjectFiles): ProjectShape {
  const entries = files.entries;
  const evidence: string[] = [];
  const dockerFile = hasAny(["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"], entries);
  const userDockerfile = Boolean(dockerFile);
  // Reported, never executed: the panel tells the user their Dockerfile was not the one running.
  if (dockerFile) evidence.push(dockerFile + " (не запускаем: сборка идёт нашим образом)");

  // Python first: its manifests are unambiguous about a running app.
  const pythonManifest = files.pythonManifest ?? "";
  const pythonFile = hasAny(["requirements.txt", "pyproject.toml", "Pipfile"], entries);
  if (pythonFile) {
    evidence.push(pythonFile);
    const framework = PYTHON_SERVER.find(name => new RegExp("(^|[^a-z])" + name, "i").test(pythonManifest));
    if (framework) evidence.push(framework);
    return {
      kind: "python-runtime",
      reason: framework
        ? "Python-приложение (" + framework + "): нужен работающий процесс, страницу показать статически нельзя"
        : "Python-проект: запускаем процесс в песочнице",
      evidence,
      userDockerfile,
    };
  }

  const deps = depsOf(files);
  const serverPackage = SERVER_PACKAGES.find(name => deps[name]);
  const startScript = startsServer(files.packageJson?.scripts);
  const configText = files.configText ?? "";
  const nextExport = /output\s*:\s*["']export["']/.test(configText);
  const nuxtGenerate = /(target\s*:\s*["']static["']|ssr\s*:\s*false)/.test(configText);

  if (files.packageJson && serverPackage && !(nextExport && (serverPackage === "next"))) {
    evidence.push(serverPackage);
    return {
      kind: "node-runtime",
      reason: "Серверный проект (" + serverPackage + "): приложение отвечает само, предпросмотру нужен процесс",
      evidence,
      userDockerfile,
    };
  }
  if (files.packageJson && startScript && !(nextExport || nuxtGenerate)) {
    evidence.push(startScript);
    return {
      kind: "node-runtime",
      reason: "Есть команда запуска (" + startScript + "): приложению нужен работающий процесс",
      evidence,
      userDockerfile,
    };
  }
  if (files.packageJson && nextExport) evidence.push("output: export");

  const buildScript = files.packageJson?.scripts?.build?.trim();
  if (files.packageJson && buildScript) {
    evidence.push("scripts.build: " + buildScript);
    const staticPackage = STATIC_PACKAGES.find(name => deps[name]);
    if (staticPackage) evidence.push(staticPackage);
    return {
      kind: "static-build",
      reason: staticPackage
        ? "Статический проект (" + staticPackage + "): собираем один раз и отдаём файлы без контейнера"
        : "Есть скрипт сборки: собираем один раз и отдаём файлы без контейнера",
      evidence,
      userDockerfile,
    };
  }

  const staticEntry = files.staticEntry ?? "";
  if (staticEntry) {
    evidence.push(staticEntry);
    return {
      kind: "instant-site",
      reason: "Готовая статика (" + staticEntry + "): показываем файлы сразу, без сборки и без контейнера",
      evidence,
      userDockerfile,
    };
  }

  if (files.packageJson) {
    evidence.push("package.json");
    return {
      kind: "unknown",
      reason: "package.json без скрипта сборки и без команды запуска: проверим проект в песочнице",
      evidence,
      userDockerfile,
    };
  }
  return { kind: "unknown", reason: "Не удалось определить тип проекта: проверяем конфигурацию", evidence, userDockerfile };
}

/** Config files whose *text* can change the answer (a static export is a config value, not a file). */
const CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts", "nuxt.config.js", "nuxt.config.ts", "vite.config.js", "vite.config.ts", "astro.config.mjs", "astro.config.ts", "svelte.config.js"];
const PYTHON_FILES = ["requirements.txt", "pyproject.toml", "Pipfile"];
/** Config text is bounded: the decision needs a line, not a project. */
const MAX_CONFIG_CHARS = 20_000;

async function readText(root: string, name: string) {
  const info = await stat(path.join(root, name)).catch(() => null);
  if (!info?.isFile()) return "";
  if (info.size > MAX_CONFIG_CHARS) return "";
  return readFile(path.join(root, name), "utf8").catch(() => "");
}

/** Reads the project root and decides what it is. One directory listing, no recursion. */
export async function detectProject(root: string): Promise<ProjectShape> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const names = entries.map(entry => entry.name);
  let packageJson: ProjectFiles["packageJson"] = null;
  const packageText = await readText(root, "package.json");
  if (packageText) {
    try {
      packageJson = JSON.parse(packageText);
    } catch {
      packageJson = null;
    }
  }
  const configText = (await Promise.all(CONFIG_FILES.map(name => readText(root, name)))).join("\n");
  const pythonManifest = (await Promise.all(PYTHON_FILES.map(name => readText(root, name)))).join("\n");
  const staticEntry = await firstStaticEntry(root);
  return classifyProject({ entries: names, packageJson, configText, pythonManifest, ...(staticEntry ? { staticEntry } : {}) });
}

/** The first ready `index.html` in the usual places, or "" when there is none. */
async function firstStaticEntry(root: string) {
  for (const candidate of STATIC_ENTRY_CANDIDATES) {
    const info = await stat(path.join(root, candidate)).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return "";
}
