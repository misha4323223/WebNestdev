/**
 * Command-line entry point for the agent eval harness.
 *
 * Without `--adapter` it only validates the catalog. With `--adapter` it imports a module that
 * exports an `adapter` function (or a default function) and runs the selected tasks through it.
 * The adapter is the only part that knows about a model, a sandbox or a fixture; keeping it
 * outside this repository's runtime means an evaluation can use a real agent without making the
 * production process depend on benchmark code.
 *
 * Пример:
 *   npm run agent:eval --workspace=server -- --list
 *   npm run agent:eval --workspace=server -- --adapter ./eval-adapter.mjs --out /tmp/eval
 */
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { EVAL_TASKS, validateEvalCatalog } from "../agent/eval/tasks.js";
import { formatEvalReportMarkdown, runEvalSuite } from "../agent/eval/runner.js";
import type { EvalAdapter, EvalLimits, EvalTask, EvalTaskSize } from "../agent/eval/types.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
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
  const id = flag("--task");
  return tasks.filter(task => (!size || task.size === size) && (!id || task.id === id));
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

async function main() {
  const selected = selectTasks(EVAL_TASKS);
  if (!selected.length) throw new Error("под выбранные фильтры не подошла ни одна задача");

  if (has("--list")) {
    printCatalog(selected);
    return;
  }

  if (!flag("--adapter")) {
    const problems = validateEvalCatalog(EVAL_TASKS);
    if (problems.length) throw new Error(problems.join("; "));
    console.log("EVAL-CATALOG=ok tasks=" + EVAL_TASKS.length + " selected=" + selected.length);
    console.log("Для настоящего прогона укажите --adapter <модуль>; без него eval не запускается.");
    return;
  }

  const adapter = await loadAdapter(flag("--adapter") as string);
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
      tasks: selected,
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
