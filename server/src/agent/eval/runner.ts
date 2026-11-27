import { randomUUID } from "node:crypto";
import {
  DEFAULT_EVAL_LIMITS,
  type EvalAdapter,
  type EvalLimits,
  type EvalMetrics,
  type EvalObservation,
  type EvalReport,
  type EvalTask,
  type EvalTaskResult,
  type EvalTaskSize,
} from "./types.js";
import { checkToolPolicy, describeToolPolicy, hasToolPolicy } from "./tool-usage.js";

/** The capability plan forbids a single eval task longer than ten minutes. */
export const MAX_EVAL_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const SIZES: EvalTaskSize[] = ["landing", "mvp", "large", "monorepo", "real"];
const MAX_ERROR_CHARS = 400;

export class EvalTaskTimeoutError extends Error {
  readonly code = "EVAL_TASK_TIMEOUT";
  constructor(taskId: string, timeoutMs: number) {
    super("задача " + taskId + " не уложилась в " + timeoutMs + " мс");
    this.name = "EvalTaskTimeoutError";
  }
}

export type RunEvalOptions = {
  tasks: EvalTask[];
  adapter: EvalAdapter;
  limits?: EvalLimits;
  signal?: AbortSignal;
  /** Injectable clock for tests; production uses Date.now. */
  now?: () => number;
  runId?: string;
  onProgress?: (result: EvalTaskResult) => void;
};

function fail(message: string): never {
  throw new Error("Eval: " + message);
}

function mergeLimits(input: EvalLimits = {}): Required<EvalLimits> {
  const limits = { ...DEFAULT_EVAL_LIMITS, ...input };
  for (const key of Object.keys(limits) as Array<keyof EvalLimits>) {
    const value = limits[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail("лимит " + key + " должен быть положительным числом");
    }
  }
  if (!Number.isInteger(limits.maxTasks)) fail("maxTasks должен быть целым");
  if (!Number.isInteger(limits.maxTotalTokens)) fail("maxTotalTokens должен быть целым");
  if (limits.taskTimeoutMs > MAX_EVAL_TASK_TIMEOUT_MS) {
    fail("taskTimeoutMs не может превышать " + MAX_EVAL_TASK_TIMEOUT_MS + " мс");
  }
  return limits;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= MAX_ERROR_CHARS ? text : text.slice(0, MAX_ERROR_CHARS - 1) + "…";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Eval остановлен");
  error.name = "AbortError";
  return error;
}

/**
 * Runs one task with two independent stops: the per-task timeout (the adapter receives the abort
 * signal and should kill the agent), and the caller's signal, which is the operator's kill switch.
 * `Promise.race` is what makes the timeout real even for an adapter that ignores the signal.
 */
async function runOneTask(
  adapter: EvalAdapter,
  task: EvalTask,
  timeoutMs: number,
  external: AbortSignal | undefined,
): Promise<EvalObservation> {
  if (external?.aborted) throw abortError(external);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onExternalAbort = () => {
    const error = abortError(external as AbortSignal);
    controller.abort(error);
    rejectAbort?.(error);
  };
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new EvalTaskTimeoutError(task.id, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      adapter(task, { signal: controller.signal, timeoutMs }),
      timeout,
      aborted,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}

function emptyObservation(error: string): EvalObservation {
  return { ok: false, error };
}

/** Свод по политике вызовов: только задачи, у которых она вообще задана. */
function toolPolicyMetrics(results: EvalTaskResult[]): EvalMetrics["toolPolicy"] {
  const outcomes = results
    .filter(result => !result.skipped && result.toolPolicy)
    .map(result => result.toolPolicy!);
  return {
    checked: outcomes.length,
    satisfied: outcomes.filter(outcome => outcome.satisfied).length,
    required: outcomes.reduce((sum, outcome) => sum + outcome.required.length, 0),
    requiredHit: outcomes.reduce((sum, outcome) => sum + outcome.required.length - outcome.missing.length, 0),
    forbiddenCalls: outcomes.reduce((sum, outcome) => sum + outcome.forbiddenCalled.length, 0),
  };
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

export function computeEvalMetrics(results: EvalTaskResult[]): EvalMetrics {
  const executed = results.filter(result => !result.skipped);
  const durations = executed.map(result => result.durationMs).sort((a, b) => a - b);
  const observations = executed.map(result => result.observation).filter((value): value is EvalObservation => Boolean(value));
  const passed = executed.filter(result => result.ok).length;
  const tokenInput = observations.reduce((sum, observation) => sum + (observation.tokens?.input ?? 0), 0);
  const tokenOutput = observations.reduce((sum, observation) => sum + (observation.tokens?.output ?? 0), 0);
  const tokenCached = observations.reduce((sum, observation) => sum + (observation.tokens?.cached ?? 0), 0);
  const steps = observations.map(observation => observation.steps).filter((value): value is number => typeof value === "number");
  const testOutcomes = observations.filter(observation => typeof observation.testsPassed === "boolean");
  const cacheRates = observations
    .map(observation => observation.cacheHitRate)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const bySize = {} as EvalMetrics["bySize"];
  for (const size of SIZES) {
    const inSize = results.filter(result => result.task.size === size);
    const sizeExecuted = inSize.filter(result => !result.skipped);
    const sizePassed = sizeExecuted.filter(result => result.ok).length;
    bySize[size] = {
      total: inSize.length,
      passed: sizePassed,
      successRate: sizeExecuted.length ? sizePassed / sizeExecuted.length : 0,
    };
  }
  return {
    total: results.length,
    passed,
    failed: executed.length - passed,
    skipped: results.length - executed.length,
    successRate: executed.length ? passed / executed.length : 0,
    durationMs: {
      total: durations.reduce((sum, value) => sum + value, 0),
      average: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    tokens: {
      input: tokenInput,
      output: tokenOutput,
      cached: tokenCached,
      total: tokenInput + tokenOutput,
    },
    costUsd: observations.reduce((sum, observation) => sum + (observation.costUsd ?? 0), 0),
    steps: {
      total: steps.reduce((sum, value) => sum + value, 0),
      average: steps.length ? Math.round(steps.reduce((sum, value) => sum + value, 0) / steps.length) : 0,
    },
    regressions: observations.reduce((sum, observation) => sum + (observation.regressions ?? 0), 0),
    interventions: observations.reduce((sum, observation) => sum + (observation.interventions ?? 0), 0),
    contextTrims: observations.reduce((sum, observation) => sum + (observation.contextTrims ?? 0), 0),
    tests: {
      passed: testOutcomes.filter(observation => observation.testsPassed === true).length,
      total: testOutcomes.length,
    },
    filesChanged: observations.reduce((sum, observation) => sum + (observation.filesChanged?.length ?? 0), 0),
    cacheHitRate: cacheRates.length ? cacheRates.reduce((sum, value) => sum + value, 0) / cacheRates.length : 0,
    toolPolicy: toolPolicyMetrics(results),
    bySize,
  };
}

/**
 * Runs a suite and returns a serialisable report. The runner never interprets a task's source:
 * pass/fail is the adapter's observation, while the runner owns the parts that must be identical
 * between stages — timeouts, cumulative budgets, skipped tasks and metrics.
 */
export async function runEvalSuite(options: RunEvalOptions): Promise<EvalReport> {
  const limits = mergeLimits(options.limits);
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const results: EvalTaskResult[] = [];
  let stoppedReason: EvalReport["stoppedReason"];
  let costUsd = 0;
  let tokens = 0;

  for (const [index, task] of options.tasks.entries()) {
    if (!stoppedReason && options.signal?.aborted) stoppedReason = "aborted";
    if (!stoppedReason && index >= limits.maxTasks) stoppedReason = "max-tasks";
    if (!stoppedReason && now() - startedAtMs >= limits.maxDurationMs) stoppedReason = "duration";
    if (!stoppedReason && costUsd >= limits.maxCostUsd) stoppedReason = "cost";
    if (!stoppedReason && tokens >= limits.maxTotalTokens) stoppedReason = "tokens";

    if (stoppedReason) {
      const at = new Date(now()).toISOString();
      const skipped: EvalTaskResult = {
        task,
        ok: false,
        skipped: true,
        startedAt: at,
        finishedAt: at,
        durationMs: 0,
      };
      results.push(skipped);
      options.onProgress?.(skipped);
      continue;
    }

    const timeoutMs = Math.min(limits.taskTimeoutMs, (task.maxMinutes ?? 10) * 60 * 1000);
    const taskStarted = now();
    let observation: EvalObservation;
    try {
      observation = await runOneTask(options.adapter, task, timeoutMs, options.signal);
    } catch (error) {
      const timedOut = error instanceof EvalTaskTimeoutError
        || (error && typeof error === "object" && (error as { code?: unknown }).code === "EVAL_TASK_TIMEOUT");
      const text = timedOut
        ? "таймаут задачи (" + timeoutMs + " мс)"
        : options.signal?.aborted
          ? "остановлено оператором"
          : messageOf(error);
      observation = emptyObservation(text);
    }
    const taskFinished = now();
    const result: EvalTaskResult = {
      task,
      ok: observation.ok,
      // Политика вызовов — отдельная строка отчёта: ok остаётся приговором адаптера, иначе
      // метрика успеха смешалась бы с дисциплиной вызова инструментов.
      ...(hasToolPolicy(task) ? { toolPolicy: checkToolPolicy(observation.toolCalls ?? [], task) } : {}),
      skipped: false,
      startedAt: new Date(taskStarted).toISOString(),
      finishedAt: new Date(taskFinished).toISOString(),
      durationMs: Math.max(0, taskFinished - taskStarted),
      observation,
      ...(observation.error ? { error: observation.error } : {}),
    };
    results.push(result);
    options.onProgress?.(result);
    costUsd += observation.costUsd ?? 0;
    tokens += (observation.tokens?.input ?? 0) + (observation.tokens?.output ?? 0);
    if (options.signal?.aborted) stoppedReason = "aborted";
  }

  const finishedAtMs = now();
  return {
    runId: options.runId ?? randomUUID(),
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    limits,
    results,
    metrics: computeEvalMetrics(results),
    ...(stoppedReason ? { stoppedReason } : {}),
  };
}

function percent(value: number): string {
  return (value * 100).toFixed(1) + "%";
}

function duration(value: number): string {
  if (value < 1000) return value + " мс";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return seconds + " с";
  return Math.floor(seconds / 60) + " мин " + (seconds % 60) + " с";
}

function cell(value: unknown): string {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** A compact report for a PR or a release note; the full transcript stays out of it. */
export function formatEvalReportMarkdown(report: EvalReport): string {
  const m = report.metrics;
  const lines: string[] = [
    "# AI eval — " + report.runId,
    "",
    "Начало: " + report.startedAt + "  ",
    "Конец: " + report.finishedAt + (report.stoppedReason ? "  \nОстановлено: " + report.stoppedReason : ""),
    "",
    "## Итог",
    "",
    "| Метрика | Значение |",
    "| --- | --- |",
    "| Задач | " + m.total + " (выполнено " + (m.total - m.skipped) + ", пропущено " + m.skipped + ") |",
    "| Успешно | " + m.passed + " / " + (m.total - m.skipped) + " |",
    "| Success rate | " + percent(m.successRate) + " |",
    "| Время | " + duration(m.durationMs.total) + " (p50 " + duration(m.durationMs.p50) + ", p95 " + duration(m.durationMs.p95) + ") |",
    "| Токены | " + m.tokens.total + " (вход " + m.tokens.input + ", выход " + m.tokens.output + ", кэш " + m.tokens.cached + ") |",
    "| Стоимость | $" + m.costUsd.toFixed(4) + " |",
    "| Шаги | " + m.steps.total + " (в среднем " + m.steps.average + ") |",
    "| Тесты | " + m.tests.passed + " / " + m.tests.total + " зелёных |",
    "| Изменено файлов | " + m.filesChanged + " |",
    "| Cache hit | " + percent(m.cacheHitRate) + " |",
    "| Инструменты | " + m.toolPolicy.requiredHit + " / " + m.toolPolicy.required + " обязательных; политика выполнена в " + m.toolPolicy.satisfied + " / " + m.toolPolicy.checked + " задачах; запрещённых вызовов " + m.toolPolicy.forbiddenCalls + " |",
    "| Регрессии | " + m.regressions + " |",
    "| Вмешательства человека | " + m.interventions + " |",
    "| Сжатия контекста | " + m.contextTrims + " |",
    "",
    "## По размерам",
    "",
    "| Размер | Задач | Успешно | Success rate |",
    "| --- | ---: | ---: | ---: |",
    ...SIZES.map(size => {
      const row = m.bySize[size];
      return "| " + size + " | " + row.total + " | " + row.passed + " | " + percent(row.successRate) + " |";
    }),
    "",
    "## Задачи",
    "",
    "| Задача | Размер | Результат | Время | Токены | Инструменты | Причина |",
    "| --- | --- | --- | ---: | ---: | --- | --- |",
    ...report.results.map(result => {
      const tokens = (result.observation?.tokens?.input ?? 0) + (result.observation?.tokens?.output ?? 0);
      const status = result.skipped ? "пропущена" : result.ok ? "успех" : "ошибка";
      return "| " + cell(result.task.id) + " | " + result.task.size + " | " + status + " | " +
        (result.skipped ? "—" : duration(result.durationMs)) + " | " + (result.skipped ? "—" : tokens) + " | " +
        (result.skipped ? "—" : cell(describeToolPolicy(result.toolPolicy))) + " | " +
        cell(result.error ?? result.observation?.error ?? "") + " |";
    }),
    "",
    "## Лимиты",
    "",
    "```json",
    JSON.stringify(report.limits, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}
