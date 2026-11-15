import test from "node:test";
import assert from "node:assert/strict";
import { EVAL_TASKS, validateEvalCatalog } from "./tasks.js";
import { computeEvalMetrics, formatEvalReportMarkdown, runEvalSuite } from "./runner.js";
import type { EvalObservation, EvalTask, EvalTaskResult } from "./types.js";

function task(id: string, size: EvalTask["size"] = "landing"): EvalTask {
  return { id, title: id, size, prompt: "сделай " + id, verify: ["true"], repo: "eval://test" };
}

function observation(overrides: Partial<EvalObservation> = {}): EvalObservation {
  return {
    ok: true,
    testsPassed: true,
    filesChanged: ["file.ts"],
    cacheHitRate: 0.5,
    steps: 3,
    tokens: { input: 100, output: 20 },
    costUsd: 0.01,
    ...overrides,
  };
}

test("каталог содержит 30–40 задач, все размеры и уникальные id", () => {
  assert.deepEqual(validateEvalCatalog(), []);
  assert.ok(EVAL_TASKS.length >= 30 && EVAL_TASKS.length <= 40);
  assert.equal(new Set(EVAL_TASKS.map(item => item.id)).size, EVAL_TASKS.length);
});

test("валидатор ловит повтор id и пустой prompt", () => {
  const problems = validateEvalCatalog([
    task("same"),
    { ...task("same"), prompt: "" },
  ]);
  assert.ok(problems.some(problem => problem.includes("повтор id")));
  assert.ok(problems.some(problem => problem.includes("пустой prompt")));
  assert.ok(problems.some(problem => problem.includes("30–40")));
});

test("успешный прогон считает success rate, токены, стоимость и шаги", async () => {
  const report = await runEvalSuite({
    tasks: [task("a"), task("b"), task("c", "large")],
    adapter: async current => observation({ steps: current.id === "a" ? 2 : 4 }),
    runId: "test-run",
  });
  assert.equal(report.runId, "test-run");
  assert.equal(report.metrics.total, 3);
  assert.equal(report.metrics.passed, 3);
  assert.equal(report.metrics.failed, 0);
  assert.equal(report.metrics.successRate, 1);
  assert.equal(report.metrics.tokens.total, 360);
  assert.equal(report.metrics.costUsd, 0.03);
  assert.equal(report.metrics.steps.total, 10);
  assert.deepEqual(report.metrics.tests, { passed: 3, total: 3 });
  assert.equal(report.metrics.filesChanged, 3);
  assert.equal(report.metrics.cacheHitRate, 0.5);
  assert.equal(report.metrics.bySize.large.total, 1);
  assert.equal(report.stoppedReason, undefined);
});

test("ошибка адаптера не роняет весь прогон", async () => {
  const report = await runEvalSuite({
    tasks: [task("ok"), task("bad")],
    adapter: async current => {
      if (current.id === "bad") throw new Error("сломалось");
      return observation();
    },
  });
  assert.equal(report.metrics.passed, 1);
  assert.equal(report.metrics.failed, 1);
  assert.equal(report.results[1].ok, false);
  assert.match(report.results[1].error ?? "", /сломалось/);
  assert.equal(report.stoppedReason, undefined);
});

test("таймаут задачи останавливает её, но не следующие", async () => {
  const report = await runEvalSuite({
    tasks: [task("slow"), task("fast")],
    limits: { taskTimeoutMs: 20 },
    adapter: async current => {
      if (current.id === "slow") return new Promise<EvalObservation>(() => {});
      return observation();
    },
  });
  assert.equal(report.results[0].ok, false);
  assert.match(report.results[0].error ?? "", /таймаут/);
  assert.equal(report.results[1].ok, true);
  assert.equal(report.metrics.passed, 1);
  assert.equal(report.metrics.failed, 1);
});

test("taskTimeoutMs ограничивает время одной задачи и не может быть больше 10 минут", async () => {
  const slow = task("slow");
  const report = await runEvalSuite({
    tasks: [slow],
    limits: { taskTimeoutMs: 20 },
    adapter: async () => new Promise<EvalObservation>(() => {}),
  });
  assert.equal(report.results[0].ok, false);
  assert.match(report.results[0].error ?? "", /таймаут/);
  await assert.rejects(
    runEvalSuite({
      tasks: [slow],
      limits: { taskTimeoutMs: 10 * 60 * 1000 + 1 },
      adapter: async () => observation(),
    }),
    /не может превышать/,
  );
});

test("maxTasks останавливает прогон, оставшиеся задачи помечены пропущенными", async () => {
  const report = await runEvalSuite({
    tasks: [task("a"), task("b"), task("c")],
    limits: { maxTasks: 1 },
    adapter: async () => observation(),
  });
  assert.equal(report.stoppedReason, "max-tasks");
  assert.equal(report.metrics.total, 3);
  assert.equal(report.metrics.passed, 1);
  assert.equal(report.metrics.skipped, 2);
  assert.equal(report.metrics.successRate, 1);
  assert.equal(report.results[2].skipped, true);
});

test("бюджет стоимости останавливает прогон до следующей задачи", async () => {
  const report = await runEvalSuite({
    tasks: [task("a"), task("b")],
    limits: { maxCostUsd: 0.01 },
    adapter: async () => observation({ costUsd: 0.02 }),
  });
  assert.equal(report.stoppedReason, "cost");
  assert.equal(report.metrics.passed, 1);
  assert.equal(report.metrics.skipped, 1);
});

test("внешний сигнал — это kill switch: новые задачи не запускаются", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const report = await runEvalSuite({
    tasks: [task("a"), task("b")],
    signal: controller.signal,
    adapter: async () => {
      calls++;
      return observation();
    },
  });
  assert.equal(calls, 0);
  assert.equal(report.stoppedReason, "aborted");
  assert.equal(report.metrics.skipped, 2);
});

test("метрики по размерам считают только выполненные задачи", () => {
  const results: EvalTaskResult[] = [
    {
      task: task("a", "landing"),
      ok: true,
      skipped: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      observation: observation(),
    },
    {
      task: task("b", "landing"),
      ok: false,
      skipped: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
    },
  ];
  const metrics = computeEvalMetrics(results);
  assert.equal(metrics.bySize.landing.total, 2);
  assert.equal(metrics.bySize.landing.passed, 1);
  assert.equal(metrics.bySize.landing.successRate, 1);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.successRate, 1);
});

test("отчёт Markdown называет упавшую задачу и не печатает транскрипт", async () => {
  const report = await runEvalSuite({
    tasks: [task("bad")],
    adapter: async () => {
      throw new Error("причина | с вертикальной чертой");
    },
    runId: "report-run",
  });
  const markdown = formatEvalReportMarkdown(report);
  assert.match(markdown, /AI eval — report-run/);
  assert.match(markdown, /bad/);
  assert.match(markdown, /ошибка/);
  assert.match(markdown, /причина \\\| с вертикальной чертой/);
});
