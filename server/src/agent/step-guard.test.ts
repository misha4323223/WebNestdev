import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SOFT_STEP_RATIO,
  createProgressDetector,
  softStepLimit,
  softStepNotice,
  stepLimitAnswer,
  stepLimitNotice,
  stepSignature,
} from "./step-guard.js";

test("мягкий предел — доля жёсткого и никогда не совпадает с ним", () => {
  assert.equal(softStepLimit(40), Math.floor(40 * DEFAULT_SOFT_STEP_RATIO));
  assert.equal(softStepLimit(40, 0.5), 20);
  assert.equal(softStepLimit(1, 0.8), 1, "при одном шаге предупреждение всё равно есть");
  assert.ok(softStepLimit(2) < 2, "мягкий предел меньше жёсткого");
});

test("доля берётся из окружения и мусор в переменной не ломает предел", () => {
  const previous = process.env.AGENT_SOFT_STEP_RATIO;
  try {
    process.env.AGENT_SOFT_STEP_RATIO = "0.5";
    assert.equal(softStepLimit(40), 20);
    process.env.AGENT_SOFT_STEP_RATIO = "2";
    assert.equal(softStepLimit(40), Math.floor(40 * DEFAULT_SOFT_STEP_RATIO), "недопустимая доля — значение по умолчанию");
    process.env.AGENT_SOFT_STEP_RATIO = "мусор";
    assert.equal(softStepLimit(40), Math.floor(40 * DEFAULT_SOFT_STEP_RATIO));
  } finally {
    if (previous === undefined) delete process.env.AGENT_SOFT_STEP_RATIO;
    else process.env.AGENT_SOFT_STEP_RATIO = previous;
  }
});

test("предупреждение называет шаг, не выдаёт готовность и просит закончить", () => {
  const notice = softStepNotice(32, 40);
  assert.match(notice, /32 of 40/);
  assert.match(notice, /finish a complete, verified result/i);
  assert.doesNotMatch(notice, /очеред/i);
});

test("последний шаг — отчёт, а не ошибка: итог, следующий шаг и слово для продолжения", () => {
  const notice = stepLimitNotice(40, 40);
  assert.match(notice, /last step/i);
  assert.match(notice, /what is already done/i);
  assert.match(notice, /what is left/i);
  assert.match(notice, /продолжай/);
  assert.doesNotMatch(notice, /ошибк/i);
  assert.match(stepLimitAnswer(), /продолжай/);
  assert.match(stepLimitAnswer(), /сохранены/);
});

test("подпись шага не зависит от порядка вызовов", () => {
  const a = { name: "fs.read", arguments: { path: "a.ts" } };
  const b = { name: "fs.read", arguments: { path: "b.ts" } };
  assert.equal(stepSignature([a, b]), stepSignature([b, a]));
  assert.notEqual(stepSignature([a]), stepSignature([b]));
});

test("детектор замечает одно и то же три шага подряд и молчит на обычной работе", () => {
  const detector = createProgressDetector();
  const read = [{ name: "fs.read", arguments: { path: "src/app.ts" } }];
  assert.equal(detector.observe(read), null);
  assert.equal(detector.observe(read), null);
  const notice = detector.observe(read);
  assert.ok(notice, "на третьем одинаковом шаге появляется заметка");
  assert.match(notice!, /NO PROGRESS/);
  assert.match(notice!, /different approach|name the blocker/);
  assert.equal(detector.observe(read), null, "заметка не повторяется каждый шаг");
});

test("смена действий и ответ без вызовов сбрасывают счётчик", () => {
  const detector = createProgressDetector();
  const first = [{ name: "fs.read", arguments: { path: "a.ts" } }];
  const second = [{ name: "fs.grep", arguments: { pattern: "foo" } }];
  detector.observe(first);
  detector.observe(first);
  detector.observe(second);
  detector.observe(first);
  detector.observe(first);
  assert.equal(detector.observe([]), null, "ответ модели обнуляет серию");
  assert.equal(detector.repeats(), 0);
  assert.equal(detector.observe(first), null, "один повтор после сброса — не застревание");
  assert.equal(detector.observe(first), null);
  assert.ok(detector.observe(first), "после сброса нужна новая серия из трёх шагов, и она снова срабатывает");
});
