import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runInSandbox, type CommandResult } from "../sandbox-worker.js";
import type { SandboxConfig } from "../sandbox-manager.js";

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
/** Та же команда, что у инструмента `npm.install`: один способ установки на всю платформу. */
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

/**
 * Установка, если она нужна. Перед сборкой и перед запуском dev-сервера вызывается одно и то
 * же: проект с готовыми зависимостями не платит за это ничем, кроме проверки каталогов.
 */
export async function ensureProjectDependencies(
  config: SandboxConfig,
  run: (config: SandboxConfig, command: string, cwd: string, options: { network?: "none" | "bridge" }) => Promise<CommandResult> = runInSandbox,
): Promise<DependencyInstallResult> {
  const missing = await missingDependencies(config.root).catch(() => null);
  if (missing === null || missing.length === 0) return { ok: true, installed: false, log: "" };

  let result: CommandResult;
  try {
    result = await run(config, INSTALL_COMMAND, config.root, { network: "bridge" });
  } catch (error) {
    return { ok: false, reason: "не удалось установить зависимости: " + (error instanceof Error ? error.message : String(error)) };
  }
  const log = installLog(result, missing);
  if (!result.ok) {
    return { ok: false, reason: "установка зависимостей не прошла: " + (failureLine(result) ?? "код выхода " + result.exitCode) };
  }
  return { ok: true, installed: true, log };
}

/** `$ npm install …` с причиной установки и последней строкой отказа, когда она не прошла. */
function installLog(result: CommandResult, missing: string[]) {
  const output = [result.stdout, result.stderr].map(value => value.replace(/\r/g, "").trim()).filter(Boolean).join("\n");
  const head = "$ " + INSTALL_COMMAND + (missing.length <= 6 ? " (" + missing.join(", ") + ")" : " (" + missing.length + " пакетов)");
  const body = output.length > MAX_LOG_CHARS ? output.slice(-MAX_LOG_CHARS) : output;
  return body ? head + "\n" + body : head;
}

function failureLine(result: CommandResult) {
  const failed = result.stderr.split("\n").map(line => line.trim()).filter(Boolean).at(-1);
  return failed ?? undefined;
}
