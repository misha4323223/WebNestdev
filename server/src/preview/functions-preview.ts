import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxConfig } from "../sandbox-manager.js";
import { buildFunctions } from "../functions/build.js";
import { readFunctionManifest, type FunctionManifest } from "../functions/manifest.js";
import { removePreviewContainer, startPreviewProcess, type StartedPreviewProcess } from "./preview-runner.js";
import { ensureProjectDependencies } from "./dependencies.js";
import { PREVIEW_APP_PORT } from "./types.js";

/**
 * Один контейнер функций на preview-сессию.
 *
 * Статический предпросмотр отдаёт файлы из процесса API. Его `/api/*` проксируется в этот
 * контейнер, который держит HTTP-runtime и загружает собранные функции по требованию.
 * Поэтому открытие страницы с несколькими запросами к API не создаёт контейнер на каждый
 * запрос, и функции проверяются до публикации.
 */

export type FunctionsPreviewExecutor = {
  containerId: string;
  host: string;
  port: number;
  runtimeDir: string;
  /** Пересобрать функции и попросить runtime перечитать модули без перезапуска контейнера. */
  reload: () => Promise<boolean>;
  stop: () => Promise<void>;
};

export type FunctionsPreviewDeps = {
  build: typeof buildFunctions;
  ensureDependencies: typeof ensureProjectDependencies;
  startProcess: typeof startPreviewProcess;
  removeContainer: typeof removePreviewContainer;
  runtimeSource: () => Promise<string>;
  supervisorSource: () => Promise<string>;
  readManifest: typeof readFunctionManifest;
};

async function defaultRuntimeSource() {
  return fileURLToPath(new URL("../functions/preview-runtime.mjs", import.meta.url));
}

async function defaultSupervisorSource() {
  return fileURLToPath(new URL("../functions/preview-supervisor.mjs", import.meta.url));
}

const defaultDeps: FunctionsPreviewDeps = {
  build: buildFunctions,
  ensureDependencies: ensureProjectDependencies,
  startProcess: startPreviewProcess,
  removeContainer: removePreviewContainer,
  runtimeSource: defaultRuntimeSource,
  supervisorSource: defaultSupervisorSource,
  readManifest: readFunctionManifest,
};

let deps: FunctionsPreviewDeps = defaultDeps;
let activeExecutors = 0;

/**
 * Потолок на процессы предпросмотра функций в одном API. Считаем контейнеры, а не запросы:
 * один executor живёт всю сессию. Без него статический preview с манифестом обходил бы общий
 * лимит runtime-предпросмотров и мог бы занять память всех нод.
 */
export function functionsPreviewMaxContainers() {
  const raw = Number(process.env.FUNCTIONS_PREVIEW_MAX_CONTAINERS ?? 4);
  return Number.isInteger(raw) && raw >= 1 && raw <= 32 ? raw : 4;
}

export function functionsPreviewStats() {
  return { active: activeExecutors, limit: functionsPreviewMaxContainers() };
}

/** Подмена только для unit-тестов: Docker и esbuild в них не запускаются. */
export function setFunctionsPreviewDepsForTests(overrides: Partial<FunctionsPreviewDeps> | null) {
  deps = { ...defaultDeps, ...(overrides ?? {}) };
}

export type StartFunctionsPreviewResult =
  | { ok: true; executor: FunctionsPreviewExecutor }
  | { ok: false; reason: string };

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function relativeRuntimeDir(root: string, dir: string) {
  const relative = path.relative(root, dir).replaceAll("\\", "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Каталог функций предпросмотра вне проекта");
  }
  return relative;
}

/**
 * Собирает функции в скрытый каталог проекта (он уже смонтирован в контейнер) и запускает
 * один постоянный runtime. Ошибка сборки или старта возвращается причиной: вызывающий
 * статический предпросмотр решает, отдать её или попробовать обычный dev-сервер.
 */
export async function startFunctionsPreviewExecutor(
  config: SandboxConfig,
  manifest: FunctionManifest,
): Promise<StartFunctionsPreviewResult> {
  if (!manifest.functions.length) return { ok: false, reason: "В манифесте нет HTTP-функций" };
  const limit = functionsPreviewMaxContainers();
  if (activeExecutors >= limit) {
    return { ok: false, reason: "Достигнут предел контейнеров предпросмотра функций (" + limit + "). Остановите другой предпросмотр и повторите." };
  }
  activeExecutors += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeExecutors = Math.max(0, activeExecutors - 1);
  };
  const session = randomUUID().replaceAll("-", "").slice(0, 16);
  const runtimeDir = path.join(config.root, ".webnestdev", "functions-preview", session);
  let started: StartedPreviewProcess | null = null;
  let watcher: FSWatcher | null = null;
  let reloadTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let reloading = false;
  let reloadPending = false;
  let currentManifest = manifest;
  let currentDir = path.join(runtimeDir, "functions-1");
  let generation = 1;
  try {
    await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
    // Сборка функций идёт esbuild'ом на хосте и должна видеть пакеты проекта. Для готовой
    // статики установки не было, поэтому проверяем зависимости и здесь.
    const dependencies = await deps.ensureDependencies(config);
    if (!dependencies.ok) return { ok: false, reason: dependencies.reason };
    await buildInto(currentDir, currentManifest);
    await copyFile(await deps.runtimeSource(), path.join(runtimeDir, "runtime.mjs"));
    await copyFile(await deps.supervisorSource(), path.join(runtimeDir, "supervisor.mjs"));
    const relativeDir = relativeRuntimeDir(config.root, currentDir);
    started = await deps.startProcess(config, {
      // Broker запрещает `--restart`, поэтому контейнер запускает supervisor, который
      // поднимает упавший runtime внутри того же контейнера. Адрес и listener не меняются.
      command: "node " + path.posix.join(relativeRuntimeDir(config.root, runtimeDir), "supervisor.mjs"),
      mode: "hybrid",
      port: PREVIEW_APP_PORT,
      persistState: false,
      ensureDependencies: false,
      env: { WEBNESTDEV_PREVIEW_FUNCTIONS_DIR: relativeDir },
    });
    if (!started.ready) {
      await deps.removeContainer(started.containerId, config.node);
      await rm(runtimeDir, { recursive: true, force: true });
      release();
      return { ok: false, reason: started.logs || "Функции предпросмотра не ответили при запуске" };
    }
    if (started.state.execOnly) {
      await deps.removeContainer(started.containerId, config.node);
      await rm(runtimeDir, { recursive: true, force: true });
      release();
      return { ok: false, reason: "Контейнер функций доступен только изнутри платформы: нужен прямой адрес для preview." };
    }

    async function buildInto(dir: string, nextManifest: FunctionManifest) {
      await deps.build({
        root: config.root,
        outDir: dir,
        manifest: nextManifest,
        // Секреты не подставляются в артефакт; runtime получает окружение контейнера.
        maxFunctionBytes: 10 * 1024 * 1024,
      });
    }

    async function rebuildAndReload() {
      if (stopped || !started) return false;
      const nextManifest = await deps.readManifest(config.root);
      if (!nextManifest?.functions.length) throw new Error("Манифест функций пуст или удалён");
      const dependencies = await deps.ensureDependencies(config);
      if (!dependencies.ok) throw new Error(dependencies.reason);
      const nextGeneration = generation + 1;
      const nextDir = path.join(runtimeDir, "functions-" + nextGeneration);
      try {
        await buildInto(nextDir, nextManifest);
        const response = await fetch("http://" + started.host + ":" + started.port + "/__preview/reload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root: relativeRuntimeDir(config.root, nextDir) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("runtime не перезагрузился: HTTP " + response.status);
        const previous = currentDir;
        currentDir = nextDir;
        currentManifest = nextManifest;
        generation = nextGeneration;
        await rm(previous, { recursive: true, force: true }).catch(() => undefined);
        return true;
      } catch (error) {
        await rm(nextDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    async function reload() {
      if (stopped) return false;
      if (reloading) {
        reloadPending = true;
        return false;
      }
      reloading = true;
      try {
        return await rebuildAndReload();
      } catch (error) {
        console.warn("[preview] функции не перезагрузились: " + describeError(error));
        return false;
      } finally {
        reloading = false;
        if (reloadPending) {
          reloadPending = false;
          scheduleReload();
        }
      }
    }

    function scheduleReload() {
      if (stopped) return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void reload();
      }, 400);
      reloadTimer.unref?.();
    }

    try {
      watcher = watch(config.root, { recursive: true }, (_event, filename) => {
        const value = String(filename ?? "").replaceAll("\\", "/");
        if (!value) return;
        if (/(^|\/)(node_modules|\.git|\.webnestdev|dist|build|out|coverage|\.cache|\.vite)(\/|$)/.test(value)) return;
        if (!/\.(?:[cm]?[jt]sx?|json)$/i.test(value)) return;
        scheduleReload();
      });
      watcher.on("error", error => console.warn("[preview] watcher функций: " + describeError(error)));
    } catch (error) {
      // Автоперезагрузка — удобство, а не условие запуска: без watcher preview всё равно работает.
      console.warn("[preview] watcher функций не поднялся: " + describeError(error));
      watcher = null;
    }

    return {
      ok: true,
      executor: {
        containerId: started.containerId,
        host: started.host,
        port: started.port,
        runtimeDir,
        reload,
        stop: async () => {
          stopped = true;
          if (reloadTimer) clearTimeout(reloadTimer);
          watcher?.close();
          watcher = null;
          try {
            await deps.removeContainer(started!.containerId, config.node);
            await rm(runtimeDir, { recursive: true, force: true });
          } finally {
            release();
          }
        },
      },
    };
  } catch (error) {
    if (started) await deps.removeContainer(started.containerId, config.node).catch(() => undefined);
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => undefined);
    release();
    return { ok: false, reason: describeError(error) };
  }
}
