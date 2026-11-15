import { lstat } from "node:fs/promises";
import path from "node:path";
import { getSandbox } from "../sandbox-manager.js";
import { readFileInside, resolveInsideSandbox } from "../sandbox/path-guard.js";
import { runInSandbox } from "../sandbox-worker.js";
import type { DockerCommandResult } from "../sandbox/docker/types.js";
import { registerTool } from "../tool-registry.js";
import { getRepoIndex } from "../agent/repo-index/build.js";
import { affectedTests } from "../agent/test-impact.js";
import { commandSucceeded } from "../agent/verification-policy.js";

/**
 * `project.test` runs the test command the project declared, once, without installing anything.
 *
 * The tool is intentionally narrow: it does not guess a runner from source files and does not
 * append test paths to an arbitrary package script. Affected tests are returned as a list for a
 * targeted follow-up; the executed command stays the one the project owns.
 */
const MAX_OUTPUT_CHARS = 5000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_AFFECTED_TESTS = 30;
const MAX_AFFECTED_COMMAND_CHARS = 3500;
const APPENDABLE_RUNNER = /\b(?:vitest|jest|node\s+--test|tsx\s+--test)\b/i;
const DEFAULT_TIMEOUT_MS = 300_000;
const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"] as const;

type PackageJson = {
  scripts?: Record<string, string>;
  packageManager?: string;
};

export type DetectedTestCommand = {
  status: "configured";
  kind: "node" | "python";
  command: string;
  packageManager: string;
  testScript?: string;
} | {
  status: "not_configured";
  reason: string;
};

async function exists(target: string) {
  return Boolean(await lstat(target).catch(() => null));
}

async function readPackage(root: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFileInside(root, path.join(root, "package.json"))) as PackageJson;
  } catch {
    return null;
  }
}

async function packageManager(root: string, pkg: PackageJson | null) {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared && ["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared;
  for (const lockfile of LOCKFILES) {
    if (await exists(path.join(root, lockfile))) return lockfile.startsWith("pnpm") ? "pnpm" : lockfile.startsWith("yarn") ? "yarn" : lockfile.startsWith("bun") ? "bun" : "npm";
  }
  return "npm";
}

/**
 * Pick the project's own test entry point. A missing `scripts.test` is reported as
 * `not_configured` instead of silently running a tool that the project never chose.
 */
export async function detectTestCommand(root: string, cwd = root): Promise<DetectedTestCommand> {
  const pkg = await readPackage(cwd);
  const script = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test.trim() : "";
  if (script) {
    const manager = await packageManager(cwd, pkg);
    return {
      status: "configured",
      kind: "node",
      command: manager === "bun" ? "bun run test" : manager + " test",
      packageManager: manager,
      testScript: script,
    };
  }

  const python =
    (await exists(path.join(cwd, "pytest.ini"))) ||
    (await exists(path.join(cwd, "pyproject.toml"))) ||
    (await exists(path.join(cwd, "setup.cfg"))) ||
    (await exists(path.join(cwd, "requirements.txt")));
  if (python) {
    return {
      status: "configured",
      kind: "python",
      command: "PYTHONPATH=.python python3 -m pytest -q",
      packageManager: "pytest",
    };
  }

  return {
    status: "not_configured",
    reason: "В package.json нет scripts.test, а pytest-конфигурации и каталога tests нет. Добавьте тестовый скрипт или тесты; инструмент не устанавливает пакеты и не угадывает раннер.",
  };
}

/** Extract a short, useful failure list from TAP, Jest/Vitest and pytest output. */
export function summarizeTestOutput(stdout: string, stderr: string): { summary: string; failures: string[]; failureDetails: TestFailureDetail[] } {
  const text = stdout + "\n" + stderr;
  const lines = text.split("\n");
  const failures = new Set<string>();
  const details = new Map<string, TestFailureDetail>();
  const add = (name: string, message?: string) => {
    const cleanName = name.trim().slice(0, 200);
    if (!cleanName) return;
    failures.add(cleanName);
    if (!details.has(cleanName)) details.set(cleanName, { name: cleanName, ...(message?.trim() ? { message: message.trim().slice(0, 240) } : {}) });
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const tap = line.match(/^\s*not ok\s+\d+\s+-\s+(.+)$/);
    if (tap) {
      let message: string | undefined;
      for (let next = index + 1; next < Math.min(lines.length, index + 14); next++) {
        const candidate = lines[next];
        const detail = candidate.match(/^\s*(?:error|message):\s*(.+)$/i);
        if (detail) message = detail[1].replace(/^\|-?\s*/, "");
        if (/^\s*\.\.\.\s*$/.test(candidate) && message) break;
      }
      add(tap[1], message);
      continue;
    }
    const jest = line.match(/^\s*FAIL\s+(.+)$/);
    if (jest) add(jest[1]);
    const marker = line.match(/^\s*●\s+(.+)$/);
    if (marker) {
      let message: string | undefined;
      for (let next = index + 1; next < Math.min(lines.length, index + 8); next++) {
        const candidate = lines[next].trim();
        if (!candidate || candidate.startsWith("●")) continue;
        message = candidate;
        break;
      }
      add(marker[1], message);
    }
    const pytest = line.match(/^\s*FAILED\s+([^ ]+)(?:\s+-\s+(.+))?$/);
    if (pytest) add(pytest[1], pytest[2]);
  }
  const failedCount = text.match(/(?:# fail\s+(\d+)|(\d+)\s+failed|(\d+)\s+failing)/i);
  const passedCount = text.match(/(?:# pass\s+(\d+)|(\d+)\s+passed)/i);
  const failed = failedCount ? Number(failedCount[1] ?? failedCount[2] ?? failedCount[3] ?? 0) : failures.size;
  const passed = passedCount ? Number(passedCount[1] ?? passedCount[2] ?? 0) : undefined;
  const summary = failed
    ? "провалено: " + failed + (passed === undefined ? "" : ", прошло: " + passed)
    : passed !== undefined
      ? "прошло: " + passed
      : failures.size
        ? "провалено: " + failures.size
        : "тесты завершились без распознанной сводки";
  return { summary, failures: [...failures].slice(0, 20), failureDetails: [...details.values()].slice(0, 20) };
}

function tail(text: string) {
  return text.length <= MAX_OUTPUT_CHARS ? text : "…[начало вывода сокращено]\n" + text.slice(-MAX_OUTPUT_CHARS);
}

/** POSIX shell quoting for a project-relative path; paths can contain spaces and quotes. */
export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export type ScopedTestCommand = {
  command: string;
  scope: "affected" | "full";
  reason?: string;
};

export type TestFailureDetail = { name: string; message?: string };

export type TestRunResult = {
  ok: boolean;
  status: "passed" | "failed" | "timeout";
  command: string;
  packageManager: string;
  testScript?: string;
  kind: "node" | "python";
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  summary: string;
  failures: string[];
  failureDetails: TestFailureDetail[];
  stdout: string;
  stderr: string;
  hint?: string;
};

/**
 * One test run, isolated from the sandbox so the result mapping can be tested with a fake
 * runner. The tool still owns sandbox selection, cwd validation and env masking.
 */
export async function runDeclaredTests(params: {
  detected: Extract<DetectedTestCommand, { status: "configured" }>;
  command: string;
  timeoutMs: number;
  run: (command: string) => Promise<DockerCommandResult>;
}): Promise<TestRunResult> {
  const started = Date.now();
  const result = await params.run(params.command);
  const output = summarizeTestOutput(result.stdout, result.stderr);
  const timedOut = result.exitCode === 124 || (result.signal != null && /timed?\s*out|timeout/i.test(result.stdout + "\n" + result.stderr));
  const ok = commandSucceeded(result);
  return {
    ok,
    status: ok ? "passed" : timedOut ? "timeout" : "failed",
    command: params.command,
    packageManager: params.detected.packageManager,
    ...(params.detected.testScript ? { testScript: params.detected.testScript } : {}),
    kind: params.detected.kind,
    durationMs: Date.now() - started,
    exitCode: result.exitCode,
    signal: result.signal,
    summary: output.summary,
    failures: output.failures,
    failureDetails: output.failureDetails,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
    ...(timedOut ? { hint: "Тесты не уложились в лимит. Увеличьте timeoutMs (до 300000) или запустите долгий набор через terminal.start." } : {}),
  };
}

/**
 * Append affected paths only when the declared script is a known runner that accepts test files.
 * An arbitrary script (`echo`, a custom orchestrator) gets the full run: guessing its arguments
 * would either do nothing or run the wrong subset while reporting success.
 */
export function scopedTestCommand(
  detected: Extract<DetectedTestCommand, { status: "configured" }>,
  tests: readonly string[],
  cwdRelative: string,
  fullRun = false,
): ScopedTestCommand {
  if (fullRun) return { command: detected.command, scope: "full", reason: "изменена конфигурация проекта" };
  if (!tests.length) return { command: detected.command, scope: "full", reason: "affected tests не найдены; полный набор безопаснее" };
  if (tests.length > MAX_AFFECTED_TESTS) {
    return { command: detected.command, scope: "full", reason: "affected tests больше " + MAX_AFFECTED_TESTS + "; запускаю полный набор" };
  }
  if (detected.kind === "node" && !APPENDABLE_RUNNER.test(detected.testScript ?? "")) {
    return { command: detected.command, scope: "full", reason: "test script не является известным раннером; аргументы не добавляю" };
  }
  if (detected.kind === "node" && /\b(?:--watch|watch)\b/i.test(detected.testScript ?? "")) {
    return { command: detected.command, scope: "full", reason: "watch-режим не подходит для одноразовой проверки" };
  }

  const relative = tests.map(test => path.posix.relative(cwdRelative || ".", test));
  if (relative.some(test => test.startsWith("..") || path.posix.isAbsolute(test))) {
    return { command: detected.command, scope: "full", reason: "часть affected tests вне cwd; запускаю полный набор" };
  }
  const args = relative.map(shellQuote).join(" ");
  const command = detected.kind === "python" ? detected.command + " " + args : detected.command + " -- " + args;
  if (command.length > MAX_AFFECTED_COMMAND_CHARS) {
    return { command: detected.command, scope: "full", reason: "команда с файлами слишком длинная; запускаю полный набор" };
  }
  return { command, scope: "affected" };
}

registerTool({
  name: "project.test",
  description:
    "Run the test command declared by the project, once, with a five-minute limit. Input: {cwd?:string,changed?:string[],timeoutMs?:number}. " +
    "It reads package.json scripts.test (npm/pnpm/yarn/bun) or uses pytest when the project has a pytest config or tests directory. " +
    "It never installs packages, never guesses a runner and never appends files to an arbitrary test script. " +
    "When `changed` is provided, the result also lists the existing tests affected through the import graph; `onlyAffected:true` runs only those paths for Vitest, Jest, node --test or pytest, and falls back to the full suite when that cannot be done safely.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      cwd: { type: "string", description: "Каталог проекта или workspace-пакета; по умолчанию корень" },
      changed: {
        type: "array",
        maxItems: 50,
        items: { type: "string" },
        description: "Изменённые файлы для расчёта affected tests; команда всё равно запускает объявленный test script",
      },
      onlyAffected: { type: "boolean", description: "Запустить только affected tests, если раннер это безопасно поддерживает; иначе полный набор" },
      timeoutMs: { type: "number", description: "Предел выполнения, от 1000 до 300000 мс; по умолчанию 300000" },
    },
  },
  execute: async (input, context) => {
    const value = (input ?? {}) as { cwd?: unknown; changed?: unknown; onlyAffected?: unknown; timeoutMs?: unknown };
    const sandbox = await getSandbox(context.projectId, context.userId);
    const requestedCwd = typeof value.cwd === "string" ? value.cwd : "";
    const cwd = await resolveInsideSandbox(sandbox.root, sandbox.root + "/" + requestedCwd);
    const detected = await detectTestCommand(sandbox.root, cwd);
    const changed = Array.isArray(value.changed)
      ? value.changed.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 50)
      : [];
    const onlyAffected = value.onlyAffected === true;
    if (onlyAffected && !changed.length) {
      throw new Error("project.test: onlyAffected требует changed — какие файлы изменены");
    }
    const affected = changed.length
      ? affectedTests(await getRepoIndex(sandbox.root, { useDiskCache: false }), changed)
      : undefined;

    if (detected.status === "not_configured") {
      return {
        ok: false,
        status: "not_configured",
        reason: detected.reason,
        ...(affected ? { affected } : {}),
      };
    }

    const timeoutMs = typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.round(value.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    const cwdRelative = path.relative(sandbox.root, cwd).split(path.sep).join("/");
    const scoped: ScopedTestCommand = onlyAffected && affected
      ? scopedTestCommand(detected, affected.tests, cwdRelative, affected.fullRun)
      : { command: detected.command, scope: "full" };
    const run = await runDeclaredTests({
      detected,
      command: scoped.command,
      timeoutMs,
      run: command => runInSandbox(sandbox, command, cwd, {
        signal: context.signal,
        maskSecretEnvFiles: true,
        timeoutMs,
        env: { CI: "1" },
      }),
    });
    return {
      ...run,
      scope: scoped.scope,
      ...(scoped.reason ? { scopeReason: scoped.reason } : {}),
      ...(affected ? { affected } : {}),
    };
  },
});
