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
import { dependencyNodePaths } from "./dependency-cache.js";
import { PREVIEW_APP_PORT } from "./types.js";

/**
 * Один контейнер функций на preview-сессию.
 *
 * Статический предпросмотр отдаёт файлы из процесса API. Его `/api/*` проксируется в этот
 * контейнер, который держит HTTP-runtime и загружает собранные функции по требованию.
 * Поэтому открытие страницы с несколькими запросами к API не создаёт контейнер на каждый
 * запрос, и функции проверяются до публикации.
 */

/** Сколько ждать ответ runtime на перезагрузку: сборка уже позади, ответ приходит сразу. */
const RELOAD_TIMEOUT_MS = 10_000;
/** В лог идёт одна строка причины отказа, а не всё тело ответа. */
const MAX_RELOAD_DETAIL = 300;

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

/** Тело отказа runtime для лога: одна строка ограниченной длины. */
async function responseDetail(response: Response) {
  const raw = await response.text().catch(() => "");
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > MAX_RELOAD_DETAIL ? text.slice(0, MAX_RELOAD_DETAIL) + "…" : text;
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
  // Идущая перезагрузка: остановка обязана её дождаться, а не убирать каталог и контейнер
  // у неё из-под рук.
  let inFlightReload: Promise<boolean> | null = null;
  /** Обрывает запрос в runtime при остановке: соединение с погашенным контейнером не нужно. */
  const stopAbort = new AbortController();
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
        // Сборка идёт в API, а node_modules — в локальном кэше ноды (см. dependency-cache.ts).
        nodePaths: dependencyNodePaths(config.projectId),
        // Секреты не подставляются в артефакт; runtime читает смонтированные `.env*`.
        maxFunctionBytes: 10 * 1024 * 1024,
      });
    }

    /**
     * POST в runtime: таймаут на зависший ответ и обрыв при остановке предпросмотра.
     * Остановка идёт одновременно с перезагрузкой, поэтому запрос не должен пережить её.
     */
    async function requestReload(relativeDir: string) {
      if (!started) throw new Error("Контейнер функций уже остановлен");
      if (stopAbort.signal.aborted) throw new Error("Предпросмотр функций остановлен");
      const controller = new AbortController();
      const abort = () => controller.abort();
      stopAbort.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, RELOAD_TIMEOUT_MS);
      timer.unref?.();
      try {
        return await fetch("http://" + started.host + ":" + started.port + "/__preview/reload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root: relativeDir }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        stopAbort.signal.removeEventListener("abort", abort);
      }
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
        const response = await requestReload(relativeRuntimeDir(config.root, nextDir));
        if (!response.ok) {
          // Тело ответа runtime — единственное место, где названа причина. Без него в логе
          // остаётся «HTTP 400», и отказ выглядит как сбой перезагрузки вообще.
          const detail = await responseDetail(response);
          throw new Error(
            "runtime не перезагрузился: HTTP " + response.status + (detail ? ": " + detail : ""),
          );
        }
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
      // Один промис на перезагрузку: его дожидается и вызывающий, и остановка. Иначе stop
      // удалил бы контейнер и каталог, пока сборка ещё пишет в них.
      const task = rebuildAndReload().catch(error => {
        // Обрыв из-за остановки — ожидаемый конец, а не дефект перезагрузки.
        if (!stopped) console.warn("[preview] функции не перезагрузились: " + describeError(error));
        return false;
      });
      inFlightReload = task;
      try {
        return await task;
      } finally {
        reloading = false;
        if (inFlightReload === task) inFlightReload = null;
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
          reloadTimer = undefined;
          watcher?.close();
          watcher = null;
          // Начатую перезагрузку обрываем и дожидаемся: иначе она продолжит писать в каталог,
          // который мы удаляем, и обращаться к контейнеру, который мы сейчас погасим.
          stopAbort.abort();
          await inFlightReload?.catch(() => undefined);
          inFlightReload = null;
          try {
            await deps.removeContainer(started!.containerId, config.node);
          } catch (error) {
            // Контейнер мог исчезнуть вместе с Docker или быть удалён уборщиком. Это не повод
            // оставлять watcher и временные файлы: освобождаем слот и чистим каталог всегда.
            console.warn("[preview] контейнер функций не удалился: " + describeError(error));
          } finally {
            await rm(runtimeDir, { recursive: true, force: true }).catch(error => {
              console.warn("[preview] временный каталог функций не удалился: " + describeError(error));
            });
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
