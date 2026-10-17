import test from "node:test";
import assert from "node:assert/strict";
import { findSecretRequest, requestSecret, resolveSecretRequest, secretRequestTimeoutMs } from "./pending-secrets.js";

const base = { projectId: "p1", userId: "u1", variable: "STRIPE_SECRET_KEY", purpose: "Оплата в проекте", file: ".env.local" };

test("запрос виден как ожидающий и разрешается подтверждением без значения", async () => {
  const { request, answer } = requestSecret(base);
  const waiting = findSecretRequest(request.id);
  assert.equal(waiting?.variable, "STRIPE_SECRET_KEY");
  assert.equal(waiting?.file, ".env.local");
  assert.equal(waiting?.projectId, "p1");
  assert.equal(resolveSecretRequest(request.id, { ok: true, variable: base.variable, file: base.file }), true);
  assert.deepEqual(await answer, { ok: true, variable: "STRIPE_SECRET_KEY", file: ".env.local" });
  // Разрешённый запрос больше не ждёт: второй ответ по нему невозможен, и модальное окно устарело.
  assert.equal(findSecretRequest(request.id), null);
  assert.equal(resolveSecretRequest(request.id, { ok: true, variable: base.variable, file: base.file }), false);
});

test("отмена пользователем доходит до инструмента без ошибки", async () => {
  const { request, answer } = requestSecret(base);
  assert.equal(resolveSecretRequest(request.id, { ok: false, cancelled: true }), true);
  assert.deepEqual(await answer, { ok: false, cancelled: true });
  assert.equal(findSecretRequest(request.id), null);
});

test("без ответа запрос истекает сам и перестаёт ждать", async () => {
  // Таймер ожидания не держит процесс живым (unref): в бою его держит сам запуск, а здесь об этом
  // должен позаботиться тест — иначе раннер решает, что событий больше нет, и отменяет файл.
  const keepAlive = setInterval(() => {}, 5);
  try {
    const { request, answer } = requestSecret({ ...base, timeoutMs: 20 });
    const resolution = await answer;
    assert.equal(resolution.ok, false);
    assert.match("error" in resolution ? resolution.error : "", /не ввёл значение/);
    assert.equal(findSecretRequest(request.id), null);
  } finally {
    clearInterval(keepAlive);
  }
});

test("остановка запуска закрывает ожидание, а не оставляет висящий запрос", async () => {
  const controller = new AbortController();
  const { request, answer } = requestSecret({ ...base, signal: controller.signal });
  controller.abort();
  const resolution = await answer;
  assert.equal(resolution.ok, false);
  assert.match("error" in resolution ? resolution.error : "", /остановлен/);
  assert.equal(findSecretRequest(request.id), null);
});

test("уже остановленный запуск не оставляет запрос ждать", async () => {
  const controller = new AbortController();
  controller.abort();
  const { request, answer } = requestSecret({ ...base, signal: controller.signal });
  assert.equal(findSecretRequest(request.id), null);
  assert.equal((await answer).ok, false);
});

test("неизвестный идентификатор не разрешается", () => {
  assert.equal(resolveSecretRequest("нет-такого", { ok: false, cancelled: true }), false);
  assert.equal(findSecretRequest("нет-такого"), null);
});

test("таймаут ожидания — пять минут по умолчанию и не меньше пяти секунд из переменной", () => {
  const previous = process.env.SECRET_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.SECRET_REQUEST_TIMEOUT_MS;
    assert.equal(secretRequestTimeoutMs(), 300_000);
    process.env.SECRET_REQUEST_TIMEOUT_MS = "1000";
    assert.equal(secretRequestTimeoutMs(), 300_000);
    process.env.SECRET_REQUEST_TIMEOUT_MS = "45000";
    assert.equal(secretRequestTimeoutMs(), 45_000);
  } finally {
    if (previous === undefined) delete process.env.SECRET_REQUEST_TIMEOUT_MS;
    else process.env.SECRET_REQUEST_TIMEOUT_MS = previous;
  }
});
