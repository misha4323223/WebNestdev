/**
 * Живая проверка перезагрузки функций предпросмотра.
 *
 * Юнит-тесты подменяют Docker, esbuild и runtime, поэтому они не доказывают, что ветка
 * перезагрузки работает в настоящем контейнере предпросмотра: runtime читает манифест из
 * смонтированного каталога, отвечает на `/__preview/reload`, а остановка идёт одновременно со
 * сборкой в другом процессе. Скрипт проходит этот путь на ВМ с настоящими Docker, esbuild и
 * контейнером:
 *
 *   1. проект с `nestdev.functions.json` запускается как предпросмотр функций и отвечает на
 *      `/api/hello` — executor собран и runtime в контейнере жив;
 *   2. правка обработчика доводит до конца горячую перезагрузку: watcher, сборка новой версии,
 *      команда runtime — контейнер при этом не перезапускается, а ответ меняется;
 *   3. отказ runtime (битый `manifest.json` новой версии) приходит причиной в журнал: строка
 *      содержит `HTTP 400` и тело ответа, а работающая версия остаётся прежней;
 *   4. остановка посреди сборки: `stop()` дожидается перезагрузки, убирает контейнер один раз,
 *      удаляет временный каталог и не выдаёт обрыв за дефект перезагрузки.
 *
 * На ВМ из каталога развёртывания (скрипт ставится в `/app/server/dist/scripts`):
 *   docker compose exec -T webnestdev-server node server/dist/scripts/functions-reload-selfcheck.js
 *
 * Код возврата: 0 — путь работает, 1 — нет. Последняя строка `FUNCTIONS-RELOAD=…` — машинный
 * вердикт. Проверка сама убирает за собой контейнер, временный проект и кэш зависимостей.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFunctions } from "../functions/build.js";
import { readFunctionManifest } from "../functions/manifest.js";
import { dockerExec } from "../preview/docker-exec.js";
import {
  functionsPreviewStats,
  setFunctionsPreviewDepsForTests,
  startFunctionsPreviewExecutor,
  type FunctionsPreviewExecutor,
} from "../preview/functions-preview.js";
import { dependencyCacheProjectDir } from "../preview/dependency-cache.js";
import { PREVIEW_LABEL } from "../preview/types.js";
import { buildSandboxConfig, sandboxImage, sandboxRootPath } from "../sandbox/config.js";
import { closeStorage, initializeStorage } from "../storage/pg.js";

/** Отдельный id: уборщик предпросмотров и лимит контейнеров считают его обычным проектом. */
const PROJECT_ID = "functions-reload-selfcheck";
const MARKER_V1 = "functions-reload-v1";
const MARKER_V2 = "functions-reload-v2";
/** Предел ожидания одной наблюдаемой стадии (сборка, ответ runtime, правка файла). */
const WAIT_MS = 60_000;
/** Пауза между опросами; сборка маленькой функции занимает доли секунды. */
const POLL_MS = 200;

function verdict(value: string) {
  console.log("FUNCTIONS-RELOAD=" + value);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Обработчик проекта: тело ответа — единственный признак того, какая версия реально работает. */
function handlerSource(marker: string) {
  return [
    "export async function handler() {",
    '  return { status: 200, headers: { "content-type": "text/plain" }, body: "' + marker + '" };',
    "}",
    "",
  ].join("\n");
}

async function writeProject(root: string, marker: string) {
  await mkdir(path.join(root, "api"), { recursive: true, mode: 0o755 });
  // `package.json` намеренно нет: тогда установка зависимостей — пустая операция, и проверка
  // не тянет за собой базу и метрики установки. Предмет проверки — перезагрузка функций.
  await writeFile(path.join(root, "nestdev.functions.json"), JSON.stringify({
    version: 1,
    runtime: "node",
    functions: [{ name: "hello", path: "/api/hello", methods: ["GET"], handler: "api/hello.ts#handler" }],
    jobs: [],
  }, null, 2));
  await writeFile(path.join(root, "api", "hello.ts"), handlerSource(marker));
}

/**
 * Отказ установки зависимостей — единственный путь запуска, где сборка и контейнер вообще не
 * появляются. Живьём он случается (например, когда пропал каталог монтирования секретов) и раньше
 * оставлял занятым слот контейнера функций и пустой временный каталог до перезапуска API.
 * Пакет с несуществующим именем роняет настоящий `npm install` за секунды.
 */
async function checkDependencyFailure(config: ReturnType<typeof buildSandboxConfig>, root: string) {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "api"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: PROJECT_ID,
    private: true,
    type: "module",
    // Такого пакета нет в реестре: настоящий `npm install` отказывает за секунды.
    dependencies: { "webnestdev-selfcheck-package-that-does-not-exist": "1.0.0" },
  }, null, 2));
  await writeFile(path.join(root, "nestdev.functions.json"), JSON.stringify({
    version: 1,
    runtime: "node",
    functions: [{ name: "hello", path: "/api/hello", methods: ["GET"], handler: "api/hello.ts#handler" }],
    jobs: [],
  }, null, 2));
  await writeFile(path.join(root, "api", "hello.ts"), handlerSource(MARKER_V1));

  const manifest = await readFunctionManifest(root);
  assert.ok(manifest, "манифест функций читается");
  const started = await startFunctionsPreviewExecutor(config, manifest);
  if (started.ok) {
    await started.executor.stop();
    assert.fail("проект с неставимой зависимостью не должен запускаться");
  }
  console.log("[functions] причина отказа установки: " + started.reason.replace(/\s+/g, " ").slice(0, 200));
  assert.equal(functionsPreviewStats().active, 0, "отказ установки освободил слот контейнера функций");
  const sessions = await readdir(path.join(root, ".webnestdev", "functions-preview")).catch(() => []);
  assert.deepEqual(sessions, [], "временный каталог неудачного запуска удалён");
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error("не дождались: " + what);
}

/** Сколько раз runtime принял новую версию: строка есть в журнале контейнера. */
function reloadCount(logs: string) {
  return (logs.match(/reloaded generation=/g) ?? []).length;
}

async function containerLogs(containerId: string) {
  const result = await dockerExec(["logs", containerId], 20_000);
  return [result.stdout, result.stderr].join("\n");
}

/** Контейнеры предпросмотра этого проекта: их не должно остаться после проверки. */
async function projectContainers() {
  const result = await dockerExec(["ps", "-aq", "--filter", "label=" + PREVIEW_LABEL + "=" + PROJECT_ID], 20_000);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

async function answer(executor: FunctionsPreviewExecutor) {
  const response = await fetch("http://" + executor.host + ":" + executor.port + "/api/hello", {
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: (await response.text()).trim() };
}

async function main(): Promise<number> {
  const root = sandboxRootPath(PROJECT_ID);
  const config = buildSandboxConfig(PROJECT_ID, root);
  console.log("[functions] проект проверки: " + root);
  console.log("[functions] контейнер: образ " + sandboxImage() + ", адрес docker — " + config.hostRoot);

  // Предупреждения исполнителя перехватываются: отказ runtime обязан быть виден в журнале, а
  // обрыв из-за остановки — наоборот, не должен выглядеть дефектом.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(value => (typeof value === "string" ? value : String(value))).join(" ");
    warnings.push(line);
    console.log("[warn] " + line);
  };

  /**
   * Сборка остаётся настоящей (`buildFunctions`), а режим задаёт только то, что нужно стадии:
   * придержать её (остановка посреди сборки) или испортить готовый манифест (отказ runtime).
   */
  let buildMode: "real" | "corrupt" | "slow" = "real";
  const gate: { release?: () => void } = {};
  setFunctionsPreviewDepsForTests({
    build: async input => {
      const mode = buildMode;
      if (mode === "slow") await new Promise<void>(resolve => { gate.release = resolve; });
      const built = await buildFunctions(input);
      if (mode === "corrupt") {
        // Runtime читает манифест сам: битый файл — это настоящий отказ runtime (HTTP 400),
        // а не подставленный ответ.
        await writeFile(path.join(input.outDir, "manifest.json"), '{"version": 1,', { mode: 0o644 });
      }
      return built;
    },
  });

  let executor: FunctionsPreviewExecutor | null = null;
  let stopped = false;
  try {
    // Запуск предпросмотра читает секреты проекта из хранилища (PostgreSQL): в процессе-скрипте
    // его нужно открыть так же, как это делает API при старте. Миграции идемпотентны и идут
    // под общей блокировкой.
    await initializeStorage();
    await checkDependencyFailure(config, root);
    console.log("[ok] отказ установки зависимостей не занял слот и не оставил каталог");
    await rm(root, { recursive: true, force: true });
    await writeProject(root, MARKER_V1);

    const manifest = await readFunctionManifest(root);
    assert.ok(manifest, "манифест функций читается");
    const started = await startFunctionsPreviewExecutor(config, manifest);
    if (!started.ok) {
      console.log("[functions] предпросмотр функций не запустился: " + started.reason);
      verdict("start-failed");
      return 1;
    }
    const running = started.executor;
    executor = running;
    console.log("[functions] контейнер " + running.containerId.slice(0, 12) + ", адрес " + running.host + ":" + running.port);

    const first = await answer(running);
    assert.equal(first.status, 200);
    assert.equal(first.body, MARKER_V1);
    console.log("[ok] функции отвечают из контейнера: " + first.body);

    const before = reloadCount(await containerLogs(running.containerId));
    // Правка файла — тот же путь, что у пользователя: watcher, сборка новой версии, команда runtime.
    await writeFile(path.join(root, "api", "hello.ts"), handlerSource(MARKER_V2));
    await until("runtime перечитал модули после правки", async () => reloadCount(await containerLogs(running.containerId)) > before);
    await until("новый ответ пришёл с сервера", async () => (await answer(running)).body === MARKER_V2);
    assert.equal((await answer(running)).body, MARKER_V2);
    // Контейнер не перезапускается: его id тот же, а версия сменилась внутри процесса.
    const inspected = await dockerExec(["inspect", "-f", "{{.State.Status}} {{.RestartCount}}", running.containerId], 20_000);
    assert.equal(inspected.stdout.trim(), "running 0", "контейнер тот же и не перезапускался");
    console.log("[ok] горячая перезагрузка: ответ " + MARKER_V2 + " без перезапуска контейнера");

    // Дожидаемся, пока watcher закончит с правкой: иначе наша перезагрузка попадёт в чужую.
    let settled = reloadCount(await containerLogs(running.containerId));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const current = reloadCount(await containerLogs(running.containerId));
      if (current === settled) break;
      settled = current;
    }
    const reloadsBeforeFailure = settled;

    buildMode = "corrupt";
    const warningsBeforeFailure = warnings.length;
    assert.equal(await running.reload(), false, "отказ runtime не считается успешной перезагрузкой");
    buildMode = "real";
    const failureLine = warnings.slice(warningsBeforeFailure).join("\n");
    assert.match(failureLine, /HTTP 400/, "в журнале есть код ответа runtime");
    // Причина — из тела ответа runtime; без него в журнале был бы только «HTTP 400».
    assert.match(failureLine, /in JSON at position|manifest\.json/, "в журнале названа причина отказа");
    assert.equal(reloadCount(await containerLogs(running.containerId)), reloadsBeforeFailure, "runtime не принял битую версию");
    assert.equal((await answer(running)).body, MARKER_V2, "работающая версия осталась прежней");
    console.log("[ok] отказ runtime пришёл причиной: " + failureLine.replace(/\s+/g, " ").slice(0, 200));

    // Остановка ровно во время сборки: сборка придержана до вызова stop().
    const warningsBeforeStop = warnings.length;
    buildMode = "slow";
    const reloadTask = running.reload();
    await until("сборка началась", async () => Boolean(gate.release));
    buildMode = "real";
    const stopping = running.stop();
    gate.release?.();
    assert.equal(await reloadTask, false, "перезагрузка, оборванная остановкой, не считается успешной");
    await stopping;
    stopped = true;
    assert.deepEqual(warnings.slice(warningsBeforeStop), [], "обрыв из-за остановки не выдаётся за дефект перезагрузки");
    await assert.rejects(stat(running.runtimeDir), "временный каталог функций удалён");
    const gone = await dockerExec(["inspect", "-f", "{{.State.Status}}", running.containerId], 20_000);
    assert.notEqual(gone.code, 0, "контейнер предпросмотра функций удалён");
    assert.deepEqual(await projectContainers(), [], "контейнеров проекта не осталось");
    assert.equal(functionsPreviewStats().active, 0, "слот контейнера функций освобождён");
    console.log("[ok] остановка посреди сборки: контейнер убран один раз, временные файлы удалены");

    verdict("ok");
    return 0;
  } catch (error) {
    console.log("[fail] " + describeError(error));
    verdict("failed");
    return 1;
  } finally {
    setFunctionsPreviewDepsForTests(null);
    if (executor && !stopped) await executor.stop().catch(() => undefined);
    console.warn = originalWarn;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(dependencyCacheProjectDir(PROJECT_ID), { recursive: true, force: true }).catch(() => undefined);
    await closeStorage().catch(() => undefined);
  }
}

process.exit(await main());
