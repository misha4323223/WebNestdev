import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerQuestionRoutes, type QuestionRouteDeps } from "./questions.js";
import { askUser, findPendingQuestion, resolvePendingQuestion } from "../questions/pending-questions.js";

async function appWith(overrides: Partial<QuestionRouteDeps> = {}) {
  const app = Fastify();
  await registerQuestionRoutes(app, {
    authorize: async () => ({ id: "u1" }),
    getProject: async id => ({ id, userId: "u1" }),
    ...overrides,
  });
  await app.ready();
  return app;
}

const options = [{ label: "Тёмная" }, { label: "Светлая" }];
const base = { projectId: "p1", userId: "u1", question: "Какую тему сделать?", options, multiSelect: false, allowCustom: true };

test("выбор варианта возвращает его ожидающему инструменту", async () => {
  const { question, answer } = askUser(base);
  const app = await appWith();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/questions/" + question.id + "/answer",
      payload: { selected: ["Светлая"] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, selected: ["Светлая"], delivered: true });
    assert.deepEqual(await answer, { ok: true, selected: ["Светлая"] });
  } finally { await app.close(); }
});

test("свой ответ уходит вместе с выбранными вариантами", async () => {
  const { question, answer } = askUser({ ...base, multiSelect: true });
  const app = await appWith();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/questions/" + question.id + "/answer",
      payload: { selected: ["Тёмная"], custom: "И оставить акцент зелёным" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await answer, { ok: true, selected: ["Тёмная"], custom: "И оставить акцент зелёным" });
  } finally { await app.close(); }
});

test("вариант, которого не было в вопросе, не принимается", async () => {
  const { question, answer } = askUser(base);
  const app = await appWith();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/questions/" + question.id + "/answer",
      payload: { selected: ["Фиолетовая"] },
    });
    assert.equal(response.statusCode, 400);
    // Вопрос продолжает ждать: отказ не должен превращаться в ответ, которого не давали.
    assert.ok(findPendingQuestion(question.id));
    assert.equal(findPendingQuestion(question.id)?.question, base.question);
  } finally {
    const pending = findPendingQuestion(question.id);
    if (pending) {
      await app.inject({ method: "POST", url: "/api/projects/p1/questions/" + question.id + "/skip" });
    }
    await answer;
    await app.close();
  }
});

test("в вопросе с одним ответом нельзя выбрать два", async () => {
  const { question, answer } = askUser(base);
  const app = await appWith();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/questions/" + question.id + "/answer",
      payload: { selected: ["Тёмная", "Светлая"] },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /только один/);
  } finally {
    await app.inject({ method: "POST", url: "/api/projects/p1/questions/" + question.id + "/skip" });
    await answer;
    await app.close();
  }
});

test("свой ответ не принимается, если вопрос его не предлагает", async () => {
  const { question, answer } = askUser({ ...base, allowCustom: false });
  const app = await appWith();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/questions/" + question.id + "/answer",
      payload: { custom: "Свой вариант" },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Свой ответ/);
  } finally {
    await app.inject({ method: "POST", url: "/api/projects/p1/questions/" + question.id + "/skip" });
    await answer;
    await app.close();
  }
});

test("пустой ответ не отправляется", async () => {
  const { question, answer } = askUser(base);
  const app = await appWith();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/questions/" + question.id + "/answer",
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.inject({ method: "POST", url: "/api/projects/p1/questions/" + question.id + "/skip" });
    await answer;
    await app.close();
  }
});

test("пропуск закрывает ожидание инструмента отказом", async () => {
  const { question, answer } = askUser(base);
  const app = await appWith();
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/questions/" + question.id + "/skip" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { cancelled: true });
    assert.deepEqual(await answer, { ok: false, cancelled: true });
  } finally { await app.close(); }
});

test("устаревшее окно ничего не отвечает за пользователя", async () => {
  const app = await appWith();
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/questions/нет-такого/answer", payload: { selected: ["Тёмная"] } });
    assert.equal(response.statusCode, 404);
  } finally { await app.close(); }
});

test("проект другого аккаунта закрыт так же, как несуществующий", async () => {
  const { question, answer } = askUser({ ...base, projectId: "p2" });
  const app = await appWith({ getProject: async id => ({ id, userId: "u2" }) });
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p2/questions/" + question.id + "/answer", payload: { selected: ["Тёмная"] } });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Проект не найден/);
  } finally {
    // Чужой маршрут вопрос не закроет, поэтому ожидание освобождается напрямую.
    resolvePendingQuestion(question.id, { ok: false, cancelled: true });
    await answer;
    await app.close();
  }
});
