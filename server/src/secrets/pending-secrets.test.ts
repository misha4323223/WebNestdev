import test from "node:test";
import assert from "node:assert/strict";
import { findSecretRequest, listSecretRequests, requestSecret, resolveSecretRequest, secretRequestRecoveryMs, secretRequestTimeoutMs } from "./pending-secrets.js";

const base = { projectId: "p1", userId: "u1", variable: "STRIPE_SECRET_KEY", purpose: "Оплата в проекте", file: ".env.local", conversationId: "c1" };

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

test("остановка запуска не теряет запрос: его можно сохранить после перезагрузки", async () => {
  const controller = new AbortController();
  const { request, answer } = requestSecret({ ...base, signal: controller.signal });
  controller.abort();
  const resolution = await answer;
  assert.equal(resolution.ok, false);
  assert.match("error" in resolution ? resolution.error : "", /остановлен/);
  // Инструмент уже не ждёт, но окно остаётся доступным: страница могла перезагрузиться.
  assert.equal(findSecretRequest(request.id)?.variable, "STRIPE_SECRET_KEY");
  const listed = listSecretRequests({ projectId: "p1", userId: "u1", conversationId: "c1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].waiting, false);
  assert.equal(listed[0].variable, "STRIPE_SECRET_KEY");
  // Сохранение закрывает отсоединённый запрос, но доставкой это уже не считается.
  assert.equal(resolveSecretRequest(request.id, { ok: true, variable: base.variable, file: base.file }), false);
  assert.equal(findSecretRequest(request.id), null);
  assert.deepEqual(listSecretRequests({ projectId: "p1", userId: "u1", conversationId: "c1" }), []);
});

test("новый запрос в том же чате заменяет старое отсоединённое окно", async () => {
  const controller = new AbortController();
  const first = requestSecret({ ...base, signal: controller.signal });
  controller.abort();
  await first.answer;
  const second = requestSecret({ ...base });
  const listed = listSecretRequests({ projectId: "p1", userId: "u1", conversationId: "c1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, second.request.id);
  assert.equal(listed[0].waiting, true);
  resolveSecretRequest(second.request.id, { ok: false, cancelled: true });
  await second.answer;
});

test("запрос из другого чата и чужого проекта не показывается", async () => {
  const controller = new AbortController();
  const first = requestSecret({ ...base, signal: controller.signal });
  controller.abort();
  await first.answer;
  assert.deepEqual(listSecretRequests({ projectId: "p1", userId: "u1", conversationId: "c2" }), []);
  assert.deepEqual(listSecretRequests({ projectId: "p2", userId: "u1", conversationId: "c1" }), []);
  assert.deepEqual(listSecretRequests({ projectId: "p1", userId: "u2", conversationId: "c1" }), []);
  resolveSecretRequest(first.request.id, { ok: false, cancelled: true });
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

test("окно после перезагрузки живёт тридцать минут и не меньше минуты из переменной", () => {
  const previous = process.env.SECRET_REQUEST_RECOVERY_MS;
  try {
    delete process.env.SECRET_REQUEST_RECOVERY_MS;
    assert.equal(secretRequestRecoveryMs(), 1_800_000);
    process.env.SECRET_REQUEST_RECOVERY_MS = "1000";
    assert.equal(secretRequestRecoveryMs(), 1_800_000);
    process.env.SECRET_REQUEST_RECOVERY_MS = "120000";
    assert.equal(secretRequestRecoveryMs(), 120_000);
  } finally {
    if (previous === undefined) delete process.env.SECRET_REQUEST_RECOVERY_MS;
    else process.env.SECRET_REQUEST_RECOVERY_MS = previous;
  }
});
