import test from "node:test";
import assert from "node:assert/strict";
import { askUser, findPendingQuestion, questionTimeoutMs, resolvePendingQuestion, type QuestionOption } from "./pending-questions.js";

const options: QuestionOption[] = [
  { label: "Тёмная тема", description: "Как в текущем макете" },
  { label: "Светлая тема" },
];

const base = { projectId: "p1", userId: "u1", question: "Какую тему сделать?", options, multiSelect: false, allowCustom: true };

test("вопрос виден как ожидающий и разрешается выбором варианта", async () => {
  const { question, answer } = askUser(base);
  const waiting = findPendingQuestion(question.id);
  assert.equal(waiting?.question, "Какую тему сделать?");
  assert.deepEqual(waiting?.options.map(option => option.label), ["Тёмная тема", "Светлая тема"]);
  assert.equal(waiting?.projectId, "p1");
  assert.equal(waiting?.multiSelect, false);
  assert.equal(waiting?.allowCustom, true);
  assert.equal(resolvePendingQuestion(question.id, { ok: true, selected: ["Светлая тема"] }), true);
  assert.deepEqual(await answer, { ok: true, selected: ["Светлая тема"] });
  // Отвеченный вопрос больше не ждёт: второй ответ по нему невозможен, окно устарело.
  assert.equal(findPendingQuestion(question.id), null);
  assert.equal(resolvePendingQuestion(question.id, { ok: true, selected: ["Тёмная тема"] }), false);
});

test("свой ответ и несколько вариантов доходят до инструмента целиком", async () => {
  const { question, answer } = askUser({ ...base, multiSelect: true });
  resolvePendingQuestion(question.id, { ok: true, selected: ["Тёмная тема", "Светлая тема"], custom: "И немного акцента" });
  assert.deepEqual(await answer, { ok: true, selected: ["Тёмная тема", "Светлая тема"], custom: "И немного акцента" });
});

test("пропуск вопроса доходит до инструмента как отказ, а не как ошибка", async () => {
  const { question, answer } = askUser(base);
  assert.equal(resolvePendingQuestion(question.id, { ok: false, cancelled: true }), true);
  assert.deepEqual(await answer, { ok: false, cancelled: true });
  assert.equal(findPendingQuestion(question.id), null);
});

test("без ответа вопрос истекает сам и перестаёт ждать", async () => {
  // Таймер ожидания не держит процесс живым (unref), поэтому в тесте его держит интервал.
  const keepAlive = setInterval(() => {}, 5);
  try {
    const { question, answer } = askUser({ ...base, timeoutMs: 20 });
    const resolution = await answer;
    assert.equal(resolution.ok, false);
    assert.match("error" in resolution ? resolution.error : "", /не ответил/);
    assert.equal(findPendingQuestion(question.id), null);
  } finally {
    clearInterval(keepAlive);
  }
});

test("остановка запуска закрывает ожидание, а не оставляет висящий вопрос", async () => {
  const controller = new AbortController();
  const { question, answer } = askUser({ ...base, signal: controller.signal });
  controller.abort();
  const resolution = await answer;
  assert.equal(resolution.ok, false);
  assert.match("error" in resolution ? resolution.error : "", /остановлен/);
  assert.equal(findPendingQuestion(question.id), null);
});

test("уже остановленный запуск не оставляет вопрос ждать", async () => {
  const controller = new AbortController();
  controller.abort();
  const { question, answer } = askUser({ ...base, signal: controller.signal });
  assert.equal(findPendingQuestion(question.id), null);
  assert.equal((await answer).ok, false);
});

test("неизвестный идентификатор не разрешается", () => {
  assert.equal(resolvePendingQuestion("нет-такого", { ok: false, cancelled: true }), false);
  assert.equal(findPendingQuestion("нет-такого"), null);
});

test("таймаут ожидания — пять минут по умолчанию и не меньше пяти секунд из переменной", () => {
  const previous = process.env.QUESTION_TIMEOUT_MS;
  try {
    delete process.env.QUESTION_TIMEOUT_MS;
    assert.equal(questionTimeoutMs(), 300_000);
    process.env.QUESTION_TIMEOUT_MS = "1000";
    assert.equal(questionTimeoutMs(), 300_000);
    process.env.QUESTION_TIMEOUT_MS = "45000";
    assert.equal(questionTimeoutMs(), 45_000);
  } finally {
    if (previous === undefined) delete process.env.QUESTION_TIMEOUT_MS;
    else process.env.QUESTION_TIMEOUT_MS = previous;
  }
});
