/**
 * Shapes shared by the agent evaluation harness.
 *
 * The harness is deliberately provider- and sandbox-agnostic: a stage of the agent is measured by
 * running the same task catalog through an adapter that knows how to prepare a workspace and how to
 * start the agent. Keeping the types here means the catalog, the runner and the report cannot drift
 * apart.
 */
import type { EvalToolCall, EvalToolPolicyOutcome } from "./tool-usage.js";

/** Task classes from the capability plan: from a one-page site to a real platform repository. */
export type EvalTaskSize = "landing" | "mvp" | "large" | "monorepo" | "real";

export type EvalTask = {
  id: string;
  title: string;
  size: EvalTaskSize;
  /** What the user would say. The adapter must not add hints that a real user would not give. */
  prompt: string;
  /** Commands that decide whether the result works. Empty means the adapter's own check. */
  verify: string[];
  /**
   * Workspace identifier resolved by the adapter (`eval://...` is a fixture it owns). The runner
   * never reads the filesystem itself, so the catalog stays usable for local fixtures and for
   * external repositories alike.
   */
  repo?: string;
  /** Soft expectations used by the report, not by the pass/fail rule. */
  expectedFiles?: string[];
  /** Инструменты, которые обязаны быть вызваны хотя бы раз. Проверяется отчётом, а не `ok`. */
  mustCall?: string[];
  /** Инструменты, которые не должны вызываться ни разу. */
  mustNotCall?: string[];
  maxSteps?: number;
  maxMinutes?: number;
  tags?: string[];
};

/** What one task run observed. All optional numbers are absent when the adapter cannot measure them. */
export type EvalObservation = {
  ok: boolean;
  testsPassed?: boolean;
  regressions?: number;
  filesChanged?: string[];
  /** Questions to the user, manual fixes, or any other human turn that the task did not require. */
  interventions?: number;
  steps?: number;
  tokens?: { input: number; output: number; cached?: number };
  costUsd?: number;
  /** How many times old context had to be trimmed for this task. */
  contextTrims?: number;
  cacheHitRate?: number;
  /** Фактические вызовы инструментов; отсутствует, если адаптер их не измеряет. */
  toolCalls?: EvalToolCall[];
  /** A short reason for a failed run; never a whole transcript. */
  error?: string;
  notes?: string;
};

export type EvalAdapterContext = {
  signal: AbortSignal;
  timeoutMs: number;
};

export type EvalAdapter = (task: EvalTask, context: EvalAdapterContext) => Promise<EvalObservation>;

export type EvalLimits = {
  /** Stop before starting task number maxTasks + 1. */
  maxTasks?: number;
  maxDurationMs?: number;
  /** Cumulative spend across completed tasks, in US dollars. */
  maxCostUsd?: number;
  /** Cumulative input + output tokens across completed tasks. */
  maxTotalTokens?: number;
  /** One task may not run longer than this; the plan forbids tasks over ten minutes. */
  taskTimeoutMs?: number;
};

export type EvalTaskResult = {
  task: EvalTask;
  ok: boolean;
  /** Сверка вызовов с `mustCall`/`mustNotCall`; есть только у задач с политикой. */
  toolPolicy?: EvalToolPolicyOutcome;
  skipped: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  observation?: EvalObservation;
  error?: string;
};

export type EvalMetrics = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  successRate: number;
  durationMs: { total: number; average: number; p50: number; p95: number };
  tokens: { input: number; output: number; cached: number; total: number };
  costUsd: number;
  steps: { total: number; average: number };
  regressions: number;
  interventions: number;
  contextTrims: number;
  /** `total` counts observations that reported a test outcome; `passed` counts green ones. */
  tests: { passed: number; total: number };
  filesChanged: number;
  /** Average of the per-task cache hit rates that the adapter could measure. */
  cacheHitRate: number;
  /**
   * Дисциплина вызова инструментов. `checked` — задачи с политикой, `satisfied` — где она
   * выполнена, `requiredHit` — сколько обязательных имён реально вызвано из `required`.
   */
  toolPolicy: { checked: number; satisfied: number; required: number; requiredHit: number; forbiddenCalls: number };
  bySize: Record<EvalTaskSize, { total: number; passed: number; successRate: number }>;
};

export type EvalReport = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  limits: Required<EvalLimits>;
  results: EvalTaskResult[];
  metrics: EvalMetrics;
  /** Why the suite stopped before the last task; `aborted` is the operator's kill switch. */
  stoppedReason?: "max-tasks" | "duration" | "cost" | "tokens" | "aborted";
};

export const DEFAULT_EVAL_LIMITS: Required<EvalLimits> = {
  maxTasks: 40,
  maxDurationMs: 60 * 60 * 1000,
  maxCostUsd: 10,
  maxTotalTokens: 5_000_000,
  taskTimeoutMs: 10 * 60 * 1000,
};
