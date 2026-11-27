import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runInSandbox, type CommandResult, type SandboxRunOptions } from "../sandbox-worker.js";
import type { SandboxConfig } from "../sandbox-manager.js";
import { npmInstallTimeoutMs, sandboxImage } from "../sandbox/config.js";
import { nodeId } from "../nodes/identity.js";
import { setPreviewStartProgress } from "./preview-start-progress.js";
import { dependencyCacheHit, dependencyEnsureCommand, dependencyLockHash } from "./dependency-cache.js";
import { recordInstallMetric } from "./install-metrics.js";
import { npmInstallEnv } from "./npm-registry.js";
import { seedStarterLayer } from "./starter-layer.js";
import { egressDenyHint } from "../egress/deny-hint.js";

/**
 * Зависимости проекта — до сборки и до dev-сервера.
 *
 * Предпросмотр собирает и запускает проект в контейнере, но `npm install` до этого никто не
 * обязан был выполнить: у проекта, только что созданного агентом, есть файлы и `package.json`,
 * а `node_modules` в нём нет. Сборка падала на `vite: not found`, следом за ней падал и
 * dev-сервер, и «предпросмотр не запускается» выглядело поломкой платформы, хотя не хватало
 * одной установки. Поэтому установка входит в запуск предпросмотра: она выполняется один раз,
 * когда зависимостей действительно не хватает, и с той же сетью, что и `npm.install` — сеть
 * нужна только ей, обычные команды песочницы остаются без неё.
 */

/** Источник, который не тянется из реестра: локальный путь или пакет этого же репозитория. */
const LOCAL_PREFIXES = ["file:", "link:", "workspace:", "portal:", "."];
/** Команда установки внутри контейнера; проверку локального кэша делает `dependencyEnsureCommand`. */
const INSTALL_COMMAND = "npm install --no-audit --no-fund";
/** В лог панели идёт только хвост вывода: он и есть причина, а весь вывод — это счётчик пакетов. */
const MAX_LOG_CHARS = 4000;

type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** Что проект объявил в `package.json`, без локальных ссылок; null — если `package.json` нет. */
export async function readDeclaredDependencies(root: string) {
  const raw = await readFile(path.join(root, "package.json"), "utf8").catch(() => null);
  if (!raw) return null;
  let parsed: PackageJson;
  try {
    parsed = JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
  const versions = { ...parsed.dependencies, ...parsed.devDependencies };
  const names = Object.keys(versions).filter(name => {
    const version = versions[name] ?? "";
    return !LOCAL_PREFIXES.some(prefix => version.startsWith(prefix));
  });
  return [...new Set(names)];
}

/**
 * Чего нет в `node_modules`. Пустой список — ставить нечего; null — у проекта нет `package.json`.
 * Проверка именно наличия объявленных пакетов, а не самого каталога: половина установки
 * (прерванный `npm install`, добавленная позже зависимость) выглядит как рабочий проект.
 */
export async function missingDependencies(root: string) {
  const declared = await readDeclaredDependencies(root);
  if (declared === null) return null;
  const missing: string[] = [];
  for (const name of declared) {
    const info = await stat(path.join(root, "node_modules", name)).catch(() => null);
    if (!info) missing.push(name);
  }
  return missing;
}

export type DependencyInstallResult = { ok: true; installed: boolean; log: string } | { ok: false; reason: string };

export type DependencyRunOptions = {
  /** Публичная сборка хостинга: никаких секретов проекта. */
  injectSecretEnvFile?: boolean;
  /** Маскировать существующие `.env*` пустыми файлами. */
  maskSecretEnvFiles?: boolean;
  /** Дополнительные mount'ы; порядок важен, публичный env идёт после масок. */
  extraMounts?: string[];
};

/**
 * Установка, если она нужна. Перед сборкой и перед запуском dev-сервера вызывается одно и то
 * же: проект с готовыми зависимостями не платит за это ничем, кроме проверки каталогов.
 */
export async function ensureProjectDependencies(
  config: SandboxConfig,
  run: (config: SandboxConfig, command: string, cwd: string, options: SandboxRunOptions) => Promise<CommandResult> = runInSandbox,
  runOptions: DependencyRunOptions = {},
): Promise<DependencyInstallResult> {
  // Хэш читается с общего storage (это маленькие файлы), а сама проверка и установка
  // выполняются в контейнере с локальным `node_modules`: у удалённой ноды API не может
  // прочитать её кэш, и устаревший Gluster-каталог не должен выглядеть установленным.
  const startedAt = performance.now();
  const hash = await dependencyLockHash(config.root).catch(() => null);
  if (hash === null) return { ok: true, installed: false, log: "" };

  // Предустановленный слой: если набор на ноде совпал с проектом до байта, дерево приезжает
  // жёсткими ссылками, а маркер получает хэш проекта — проверка ниже увидит «cached» и
  // npm install не запустится. Проект со своими версиями (человек написал промт, агент выбрал
  // пакеты сам) просто не получит слой и пойдёт обычным путём.
  const layer = await seedStarterLayer({ projectId: config.projectId, hash })
    .catch(() => ({ seeded: false, reason: "слой недоступен" }));

  setPreviewStartProgress(config.projectId, "installing", "Проверяем зависимости…");
  // Локальное зеркало реестра: только адрес, без доступа к чему-либо ещё. Не задано или не
  // отвечает — пустой объект, и установка идёт в публичный реестр, как раньше.
  const installEnv = await npmInstallEnv().catch(() => ({}));
  const report = async (result: "ok" | "failed", cached: boolean) => {
    await recordInstallMetric({
      at: Date.now(),
      projectId: config.projectId,
      node: nodeId(),
      image: sandboxImage(),
      result,
      cached,
      layer: layer.seeded,
      mirror: Object.keys(installEnv).length > 0,
      durationMs: Math.round(performance.now() - startedAt),
    });
  };
  let result: CommandResult;
  try {
    // Lifecycle-скрипты проекта могут читать env; предпросмотр получает канонические секреты,
    // но только на время установки — файл удаляется сразу после команды.
    result = await run(config, dependencyEnsureCommand(hash), config.root, {
      network: "bridge",
      // Установка не должна упираться в общий лимит команды: большое дерево идёт минуты.
      timeoutMs: npmInstallTimeoutMs(),
      injectSecretEnvFile: runOptions.injectSecretEnvFile ?? true,
      maskSecretEnvFiles: runOptions.maskSecretEnvFiles ?? false,
      extraMounts: runOptions.extraMounts ?? [],
      env: Object.keys(installEnv).length ? installEnv : undefined,
    });
  } catch (error) {
    await report("failed", false);
    return { ok: false, reason: "не удалось установить зависимости: " + (error instanceof Error ? error.message : String(error)) };
  }
  if (!result.ok) {
    await report("failed", false);
    // Установка идёт через прокси платформы: отказ фильтра иначе выглядит как «не удалось
    // поставить зависимости», и агент ищет причину в package.json вместо списка доменов.
    const hint = egressDenyHint(result.stdout + "\n" + result.stderr);
    return {
      ok: false,
      reason:
        "установка зависимостей не прошла: " +
        (failureLine(result) ?? "код выхода " + result.exitCode) +
        (hint ? ". " + hint : ""),
    };
  }
  const output = [result.stdout, result.stderr].join("\n");
  const installed = !dependencyCacheHit(output);
  await report("ok", !installed);
  return { ok: true, installed, log: installed ? installLog(result) : "" };
}

/** `$ npm install …` с причиной установки и последней строкой отказа, когда она не прошла. */
function installLog(result: CommandResult) {
  const output = [result.stdout, result.stderr].map(value => value.replace(/\r/g, "").trim()).filter(Boolean).join("\n");
  const head = "$ " + INSTALL_COMMAND + " (локальный кэш ноды)";
  const body = output.length > MAX_LOG_CHARS ? output.slice(-MAX_LOG_CHARS) : output;
  return body ? head + "\n" + body : head;
}

function failureLine(result: CommandResult) {
  const failed = result.stderr.split("\n").map(line => line.trim()).filter(Boolean).at(-1);
  return failed ?? undefined;
}
