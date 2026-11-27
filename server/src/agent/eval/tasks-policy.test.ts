import test from "node:test";
import assert from "node:assert/strict";
import { EVAL_TASKS, validateEvalCatalog } from "./tasks.js";

test("каталог содержит задачи с политикой вызовов и остаётся валидным", () => {
  assert.deepEqual(validateEvalCatalog(), []);
  const withPolicy = EVAL_TASKS.filter(task =>
    (task.mustCall?.length ?? 0) + (task.mustNotCall?.length ?? 0) > 0,
  );
  assert.ok(
    withPolicy.length >= 10,
    "политика должна быть у 10+ задач, сейчас " + withPolicy.length,
  );
  // Инструмент, который обязан быть вызван и запрещён одновременно, — противоречие в задаче.
  for (const task of withPolicy) {
    for (const name of task.mustCall ?? []) {
      assert.ok(!(task.mustNotCall ?? []).includes(name), task.id + ": " + name + " одновременно обязателен и запрещён");
    }
  }
});

test("валидатор ловит противоречивую политику", () => {
  const problems = validateEvalCatalog([
    {
      id: "противоречие",
      title: "противоречие",
      size: "landing",
      prompt: "сделай",
      verify: ["true"],
      mustCall: ["seo.check"],
      mustNotCall: ["seo.check"],
    },
  ]);
  assert.ok(problems.some(problem => problem.includes("одновременно обязательный и запрещённый")));
});
