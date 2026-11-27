import test from "node:test";
import assert from "node:assert/strict";
import { checkToolPolicy, describeToolPolicy, hasToolPolicy, summarizeToolCalls } from "./tool-usage.js";
import { runEvalSuite } from "./runner.js";
import type { EvalObservation, EvalTask } from "./types.js";

test("summary считает вызовы и не зависит от порядка событий", () => {
  const calls = summarizeToolCalls(["fs.read", "database.status", "fs.read", "", " fs.read "]);
  assert.deepEqual(calls, [
    { name: "fs.read", count: 3 },
    { name: "database.status", count: 1 },
  ]);
});

test("политика выполнена, когда все обязательные вызваны и запрещённых нет", () => {
  const outcome = checkToolPolicy(
    [{ name: "database.status", count: 1 }, { name: "fs.write", count: 4 }],
    { mustCall: ["database.status"], mustNotCall: ["web.search"] },
  );
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.forbiddenCalled, []);
  assert.equal(outcome.satisfied, true);
  assert.equal(describeToolPolicy(outcome), "ok");
});

test("политика называет забытые и лишние инструменты", () => {
  const outcome = checkToolPolicy(
    [{ name: "web.search", count: 1 }],
    { mustCall: ["secrets.request", "plan.update"], mustNotCall: ["web.search"] },
  );
  assert.deepEqual(outcome.missing, ["secrets.request", "plan.update"]);
  assert.deepEqual(outcome.forbiddenCalled, ["web.search"]);
  assert.equal(outcome.satisfied, false);
  assert.equal(describeToolPolicy(outcome), "не вызваны: secrets.request, plan.update; лишние: web.search");
});

test("без политики строка не появляется и ничего не считается нарушением", () => {
  assert.equal(hasToolPolicy({}), false);
  assert.equal(hasToolPolicy({ mustCall: ["  "] }), false);
  assert.equal(checkToolPolicy([]).satisfied, true);
  assert.equal(describeToolPolicy(undefined), "—");
});

function toolTask(id: string, policy: Partial<EvalTask> = {}): EvalTask {
  return { id, title: id, size: "landing", prompt: id, verify: ["true"], repo: "eval://test", ...policy };
}

function observed(toolCalls: EvalObservation["toolCalls"]): EvalObservation {
  return { ok: true, steps: 2, tokens: { input: 10, output: 5 }, toolCalls };
}

test("отчёт eval считает дисциплину вызовов отдельно от успеха задачи", async () => {
  const report = await runEvalSuite({
    tasks: [
      toolTask("пишет данные", { mustCall: ["database.status"], mustNotCall: ["web.search"] }),
      toolTask("спрашивает ключ", { mustCall: ["secrets.request"], mustNotCall: ["web.search"] }),
      toolTask("без политики"),
    ],
    adapter: async task => {
      if (task.id === "пишет данные") return observed([{ name: "database.status", count: 1 }, { name: "fs.write", count: 2 }]);
      if (task.id === "спрашивает ключ") return observed([{ name: "web.search", count: 1 }]);
      return observed([{ name: "fs.read", count: 3 }]);
    },
  });

  assert.equal(report.metrics.passed, 3, "ok задачи не меняется из-за политики");
  assert.deepEqual(report.metrics.toolPolicy, {
    checked: 2,
    satisfied: 1,
    required: 2,
    requiredHit: 1,
    forbiddenCalls: 1,
  });
  const failed = report.results.find(result => result.task.id === "спрашивает ключ");
  assert.equal(failed?.toolPolicy?.satisfied, false);
  assert.deepEqual(failed?.toolPolicy?.missing, ["secrets.request"]);

  const markdown = (await import("./runner.js")).formatEvalReportMarkdown(report);
  assert.match(markdown, /Инструменты/);
  assert.match(markdown, /не вызваны: secrets\.request/);
  assert.match(markdown, /1 \/ 2 обязательных/);
});
