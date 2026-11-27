import test from "node:test";
import assert from "node:assert/strict";
import { isContinuation, resolveObjective } from "./goal-from-history.js";

test("продолжение распознаётся, обычная просьба — нет", () => {
  for (const phrase of ["продолжай", "продолжай!", "да", "ок", "давай дальше", "continue", "go on"]) {
    assert.equal(isContinuation(phrase), true, phrase);
  }
  for (const phrase of ["поправь цвет кнопки", "добавь корзину", "продолжай работу над оплатой"]) {
    assert.equal(isContinuation(phrase), false, phrase);
  }
});

test("с незавершённым планом целью остаётся прошлая просьба", () => {
  const objective = resolveObjective({
    task: "продолжай",
    previousUserMessages: ["Сделай лендинг для студии", "Добавь форму заявки"],
    hasActivePlan: true,
  });
  assert.equal(objective, "Добавь форму заявки");
});

test("без плана и без истории цель — сама реплика", () => {
  assert.equal(
    resolveObjective({ task: "продолжай", previousUserMessages: ["сделай сайт"], hasActivePlan: false }),
    "продолжай",
  );
  assert.equal(
    resolveObjective({ task: "продолжай", previousUserMessages: [], hasActivePlan: true }),
    "продолжай",
  );
});

test("новая содержательная просьба всегда становится целью", () => {
  assert.equal(
    resolveObjective({ task: "добавь корзину", previousUserMessages: ["сделай магазин"], hasActivePlan: true }),
    "добавь корзину",
  );
});

test("пустая реплика берёт последнюю просьбу из истории", () => {
  assert.equal(
    resolveObjective({ task: "  ", previousUserMessages: ["сделай сайт"], hasActivePlan: false }),
    "сделай сайт",
  );
});
