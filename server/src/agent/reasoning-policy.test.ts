import test from "node:test";
import assert from "node:assert/strict";
import { resolveReasoning } from "./reasoning-policy.js";

const base = { requested: "auto" as const, step: 1, task: "поправь кнопку", mode: "developer" as const };

test("явный выбор пользователя не переопределяется автоматикой", () => {
  assert.equal(resolveReasoning({ ...base, requested: "high" }), "high");
  assert.equal(resolveReasoning({ ...base, requested: "low", task: "сложная архитектурная миграция" }), "low");
  assert.equal(resolveReasoning({ ...base, requested: "medium" }), "medium");
});

test("короткая механическая правка начинается с низкой глубины", () => {
  assert.equal(resolveReasoning(base), "low");
});

test("сложная задача начинается с высокой глубины", () => {
  assert.equal(resolveReasoning({ ...base, task: "спроектируй архитектуру и миграцию базы" }), "high");
  assert.equal(resolveReasoning({ ...base, task: "x".repeat(700) }), "high");
});

test("после первой ошибки проверки глубина повышается", () => {
  assert.equal(resolveReasoning({ ...base, step: 4, verificationFailures: 1 }), "high");
  assert.equal(resolveReasoning({ ...base, step: 4, verificationFailures: 2 }), "high");
});

test("после начала работы рутинные шаги идут дешевле", () => {
  assert.equal(resolveReasoning({ ...base, step: 3, changedFiles: 1 }), "low");
  assert.equal(resolveReasoning({ ...base, step: 4, task: "сложная архитектурная миграция", changedFiles: 1 }), "low");
});

test("планировщик дольше остаётся на средней глубине", () => {
  assert.equal(resolveReasoning({ ...base, mode: "planner", task: "составь план" }), "medium");
  assert.equal(resolveReasoning({ ...base, mode: "planner", task: "составь план", step: 2 }), "medium");
  assert.equal(resolveReasoning({ ...base, mode: "planner", task: "составь план", step: 3 }), "low");
});

test("продолжение прерванного запуска начинается с высокой глубины", () => {
  assert.equal(resolveReasoning({ ...base, resumed: true }), "high");
});
