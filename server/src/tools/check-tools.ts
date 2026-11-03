import { lstat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { readFileInside } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";
import { registerTool } from "../tool-registry.js";

/**
 * `project.check` — проверка исходников, которую не делает `vite build`.
 *
 * Сборка отвечает «страница собралась», а не «типы сходятся»: Vite транспилирует TypeScript без
 * проверки типов, поэтому неиспользуемая переменная, неверный prop или опечатка в импорте
 * спокойно доезжают до предпросмотра. Инструмент читает `package.json` и запускает то, что проект
 * объявил сам: `typecheck`/`npm run lint`, а если скрипта нет — локальный `tsc --noEmit` при
 * наличии `tsconfig.json` и установленного TypeScript.
 *
 * Это не установка пакетов и не сеть: `npx` здесь запрещён, потому что в песочнице нет сети, а
 * `npx tsc` без локального пакета ушёл бы в таймаут. Если TypeScript не установлен, инструмент
 * честно говорит `not_configured` и предлагает `npm.install`, а не делает вид, что проверил.
 */

const MAX_OUTPUT_CHARS = 4000;
const CHECK_TIMEOUT_MS = 180_000;

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type CheckOutcome = {
  name: "typecheck" | "lint";
  status: "passed" | "failed" | "not_configured";
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  reason?: string;
};

function tail(text: string, limit = MAX_OUTPUT_CHARS) {
  if (text.length <= limit) return text;
  return "…[начало вывода сокращено]\n" + text.slice(-limit);
}

async function readPackage(root: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFileInside(root, path.join(root, "package.json"))) as PackageJson;
  } catch {
    return null;
  }
}

async function exists(target: string) {
  return Boolean(await lstat(target).catch(() => null));
}

/** Команды проверки выбираются один раз до запуска, чтобы отчёт называл точную команду. */
export async function resolveChecks(root: string, packageJson: PackageJson | null, want: { typecheck: boolean; lint: boolean }) {
  const checks: Array<{ name: "typecheck" | "lint"; command: string }> = [];
  const skipped: CheckOutcome[] = [];
  const scripts = packageJson?.scripts ?? {};

  if (want.typecheck) {
    if (typeof scripts.typecheck === "string" && scripts.typecheck.trim()) {
      checks.push({ name: "typecheck", command: "npm run typecheck" });
    } else if (await exists(path.join(root, "tsconfig.json"))) {
      const localTsc = path.join(root, "node_modules", ".bin", "tsc");
      if (await exists(localTsc)) checks.push({ name: "typecheck", command: "./node_modules/.bin/tsc --noEmit" });
      else {
        skipped.push({
          name: "typecheck",
          status: "not_configured",
          reason: "tsconfig.json есть, но TypeScript не установлен: выполните npm.install или добавьте скрипт typecheck",
        });
      }
    } else {
      skipped.push({
        name: "typecheck",
        status: "not_configured",
        reason: "нет tsconfig.json и скрипта typecheck — проект не TypeScript",
      });
    }
  }

  if (want.lint) {
    if (typeof scripts.lint === "string" && scripts.lint.trim()) {
      checks.push({ name: "lint", command: "npm run lint" });
    } else {
      skipped.push({
        name: "lint",
        status: "not_configured",
        reason: "в package.json нет скрипта lint — добавьте его, если проект использует линтер",
      });
    }
  }

  return { checks, skipped };
}

registerTool({
  name: "project.check",
  description:
    "Check the project's source code with the checks it declares, without starting Preview. Input: {typecheck?:boolean, lint?:boolean, timeoutMs?:number}. By default it runs TypeScript: `npm run typecheck` when that script exists, otherwise a local `./node_modules/.bin/tsc --noEmit` when tsconfig.json and TypeScript are installed. `lint:true` also runs `npm run lint` when the script exists. It never installs packages and never uses npx (the sandbox has no network); a missing check is reported as `not_configured`, not as a pass. Use it after editing TS/TSX files, before project.verify or browser.runtime.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      typecheck: { type: "boolean", description: "Проверить TypeScript; по умолчанию true" },
      lint: { type: "boolean", description: "Запустить npm run lint, если скрипт объявлен; по умолчанию false" },
      timeoutMs: { type: "number", description: "Предел одной проверки в миллисекундах, по умолчанию 180000" },
    },
  },
  execute: async (input, context) => {
    const value = (input && typeof input === "object" ? input : {}) as {
      typecheck?: unknown;
      lint?: unknown;
      timeoutMs?: unknown;
    };
    const want = {
      // TypeScript — проверка по умолчанию; отключить её можно только явным false.
      typecheck: value.typecheck !== false,
      lint: value.lint === true,
    };
    const timeoutMs = typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
      ? Math.min(300_000, Math.max(10_000, Math.round(value.timeoutMs)))
      : CHECK_TIMEOUT_MS;

    const sandbox = await getSandbox(context.projectId, context.userId);
    const packageJson = await readPackage(sandbox.root);
    const { checks, skipped } = await resolveChecks(sandbox.root, packageJson, want);
    const outcomes: CheckOutcome[] = [...skipped];

    for (const check of checks) {
      try {
        const result = await runInSandbox(sandbox, check.command, sandbox.root, {
          signal: context.signal,
          maskSecretEnvFiles: true,
          timeoutMs,
        });
        const passed = result.ok === true && result.exitCode === 0 && result.signal == null;
        outcomes.push({
          name: check.name,
          status: passed ? "passed" : "failed",
          command: check.command,
          exitCode: result.exitCode,
          ...(result.stdout ? { stdout: tail(result.stdout) } : {}),
          ...(result.stderr ? { stderr: tail(result.stderr) } : {}),
        });
        // Первый провал останавливает дальнейшие проверки: линт после сломанного TypeScript
        // только добавляет шум, а агент всё равно сначала исправляет типы.
        if (!passed) break;
      } catch (error) {
        outcomes.push({
          name: check.name,
          status: "failed",
          command: check.command,
          reason: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    const failed = outcomes.find(check => check.status === "failed");
    const configured = outcomes.some(check => check.status !== "not_configured");
    return {
      ok: !failed,
      configured,
      checks: outcomes,
      ...(failed
        ? {
            reason: failed.name + " не прошёл: " + (failed.reason ?? (failed.stderr?.split("\n").find(Boolean) ?? "exit code " + failed.exitCode)),
            nextAction: "Исправьте первую ошибку в выводе и запустите project.check снова. Не считайте сборку доказательством типов.",
          }
        : configured
          ? { nextAction: "Проверки прошли. Теперь можно запускать project.verify и browser.runtime." }
          : { note: "В проекте нет настроенной проверки TypeScript или lint. Это не ошибка: не выдумывайте результат, а скажите пользователю, что проверка не настроена." }),
    };
  },
});
