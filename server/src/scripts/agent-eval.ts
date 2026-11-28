/**
 * Command-line entry point for the agent eval harness.
 *
 * Three modes:
 * - no flags: validate the catalog only (safe in CI, no model, no database);
 * - `--adapter <module>`: run through an external adapter module;
 * - `--live`: run the real `AgentRuntime` on the configured platform model inside a temporary
 *   project, with the project's own `verify` commands and a hidden per-task check deciding `ok`.
 *
 * Пример:
 *   npm run agent:eval --workspace=server -- --list
 *   npm run agent:eval --workspace=server -- --live --size landing --out /tmp/eval
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { EVAL_TASKS, validateEvalCatalog } from "../agent/eval/tasks.js";
import { formatEvalReportMarkdown, runEvalSuite } from "../agent/eval/runner.js";
import { tasksWithFixtures, tasksWithoutFixtures } from "../agent/eval/live/fixtures/index.js";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";
import type { EvalAdapter, EvalLimits, EvalTask, EvalTaskSize } from "../agent/eval/types.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
/** Повторяемый флаг: `--task a --task b` выбирает несколько задач, а не только первую. */
const flags = (name: string) =>
  args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1] as string] : []));
const has = (name: string) => args.includes(name);

function numberFlag(name: string): number | undefined {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + " должен быть положительным числом");
  return value;
}

function selectTasks(tasks: EvalTask[]): EvalTask[] {
  const size = flag("--size") as EvalTaskSize | undefined;
  if (size && !["landing", "mvp", "large", "monorepo", "real"].includes(size)) {
    throw new Error("--size: ожидается landing, mvp, large, monorepo или real");
  }
  const ids = flags("--task");
  return tasks.filter(task => (!size || task.size === size) && (!ids.length || ids.includes(task.id)));
}

function printCatalog(tasks: EvalTask[]) {
  for (const task of tasks) {
    console.log([task.size, task.id, task.title].join("\t"));
  }
  console.log("всего: " + tasks.length);
}

async function loadAdapter(specifier: string): Promise<EvalAdapter> {
  const module = await import(pathToFileURL(path.resolve(specifier)).href) as {
    adapter?: unknown;
    default?: unknown;
  };
  const candidate = module.adapter ?? module.default;
  if (typeof candidate !== "function") {
    throw new Error("модуль адаптера должен экспортировать adapter (или default) функцией");
  }
  return candidate as EvalAdapter;
}

/** `--user` принимает id или email; без него берётся первый аккаунт базы. */
async function resolveUserId(specifier: string | undefined): Promise<string> {
  const store = await import("../auth/auth-store.js");
  if (specifier?.trim()) {
    const value = specifier.trim();
    if (value.includes("@")) {
      const user = await store.findUserByEmail(value);
      if (!user) throw new Error("пользователь не найден: " + value);
      return user.id;
    }
    const user = await store.getUser(value);
    if (!user) throw new Error("пользователь не найден: " + value);
    return user.id;
  }
  const identities = await store.listUserIdentities();
  const first = identities[0];
  if (!first) throw new Error("в базе нет ни одного аккаунта: создайте пользователя и повторите");
  console.log("EVAL-LIVE user=" + first.email);
  return first.id;
}

function resolvePlan(): PlanId {
  const plan = (flag("--plan") ?? "pro").trim();
  if (!(plan in PLAN_CATALOG)) {
    throw new Error("--plan: ожидается " + Object.keys(PLAN_CATALOG).join(", "));
  }
  return plan as PlanId;
}

async function liveAdapter(): Promise<EvalAdapter> {
  // Инструменты регистрируются импортом их модулей — ровно как при старте сервера. Без этого
  // реестр пуст, и модель получает запрос без `tools`.
  await import("../tools/register.js");
  const { toolNames } = await import("../tool-registry.js");
  if (!toolNames().length) throw new Error("реестр инструментов пуст: eval не сможет измерить агента");
  // The server initialises storage and reads the panel's platform keys before serving; a standalone
  // eval process must do both itself, otherwise the first project lookup fails with "PostgreSQL
  // pool is not initialized" and the model call would silently use the deploy-time env key.
  const storage = await import("../storage/ydb.js");
  await storage.initializeStorage();
  const platform = await import("../platform/platform-env.js");
  await platform.loadPlatformEnv();
  const { createLiveEvalAdapter } = await import("../agent/eval/live/adapter.js");
  const commandTimeoutMs = numberFlag("--command-timeout-ms");
  return createLiveEvalAdapter({
    userId: await resolveUserId(flag("--user")),
    plan: resolvePlan(),
    keepProjects: has("--keep-projects"),
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
  });
}

async function main() {
  const selected = selectTasks(EVAL_TASKS);
  if (!selected.length) throw new Error("под выбранные фильтры не подошла ни одна задача");

  if (has("--list")) {
    printCatalog(selected);
    return;
  }

  if (has("--live") && flag("--adapter")) {
    throw new Error("--live и --adapter взаимоисключающие: выберите один источник адаптера");
  }

  if (!has("--live") && !flag("--adapter")) {
    const problems = validateEvalCatalog(EVAL_TASKS);
    if (problems.length) throw new Error(problems.join("; "));
    console.log("EVAL-CATALOG=ok tasks=" + EVAL_TASKS.length + " selected=" + selected.length);
    console.log("Покрытие фикстурами для --live: " + tasksWithFixtures().length + " из " + EVAL_TASKS.length);
    console.log("Для настоящего прогона укажите --live или --adapter <модуль>; без них eval не запускается.");
    return;
  }

  let tasks = selected;
  let adapter: EvalAdapter;
  if (has("--live")) {
    tasks = tasksWithFixtures(selected);
    const missing = tasksWithoutFixtures(selected);
    console.log("EVAL-LIVE tasks=" + tasks.length + " без фикстуры=" + missing.length +
      (missing.length ? " (" + missing.map(task => task.id).join(", ") + ")" : ""));
    if (!tasks.length) throw new Error("у выбранных задач нет ни одной фикстуры для --live");
    adapter = await liveAdapter();
  } else {
    adapter = await loadAdapter(flag("--adapter") as string);
  }

  const limits: EvalLimits = {
    ...(numberFlag("--max-tasks") !== undefined ? { maxTasks: numberFlag("--max-tasks") as number } : {}),
    ...(numberFlag("--duration-ms") !== undefined ? { maxDurationMs: numberFlag("--duration-ms") as number } : {}),
    ...(numberFlag("--cost-usd") !== undefined ? { maxCostUsd: numberFlag("--cost-usd") as number } : {}),
    ...(numberFlag("--tokens") !== undefined ? { maxTotalTokens: numberFlag("--tokens") as number } : {}),
    ...(numberFlag("--timeout-ms") !== undefined ? { taskTimeoutMs: numberFlag("--timeout-ms") as number } : {}),
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const report = await runEvalSuite({
      tasks,
      adapter,
      limits,
      signal: controller.signal,
      onProgress: result => {
        const status = result.skipped ? "skip" : result.ok ? "ok" : "fail";
        console.log("[" + status + "] " + result.task.id + (result.error ? " — " + result.error : ""));
      },
    });
    const base = (flag("--out") ?? "eval-report").replace(/\.(json|md)$/i, "");
    await writeFile(base + ".json", JSON.stringify(report, null, 2) + "\n", "utf8");
    await writeFile(base + ".md", formatEvalReportMarkdown(report), "utf8");
    console.log("EVAL-RUN=" + (report.metrics.failed === 0 ? "ok" : "failed") +
      " passed=" + report.metrics.passed + " failed=" + report.metrics.failed +
      " skipped=" + report.metrics.skipped + " report=" + base + ".md");
    if (report.metrics.failed > 0) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(error => {
  console.error("[eval] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
