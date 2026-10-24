import test from "node:test";
import assert from "node:assert/strict";
import { accessRequestTimeoutMs, findAccessRequest, requestAccess, resolveAccessRequest } from "./pending-access.js";

const base = { projectId: "p1", userId: "u1", kind: "cloud" as const, providerId: "timeweb" };

test("запрос доступа виден ожидающим и разрешается подтверждением без секретов", async () => {
  const { request, answer } = requestAccess(base);
  const waiting = findAccessRequest(request.id);
  assert.equal(waiting?.kind, "cloud");
  assert.equal(waiting?.providerId, "timeweb");
  assert.equal(waiting?.projectId, "p1");
  assert.ok(waiting!.expiresAt > waiting!.createdAt);

  assert.equal(resolveAccessRequest(request.id, { ok: true, account: "user@example.com" }), true);
  assert.deepEqual(await answer, { ok: true, account: "user@example.com" });
  // Повторное окно по тому же запросу уже не откроется: значение не должно выглядеть сохранённым дважды.
  assert.equal(findAccessRequest(request.id), null);
  assert.equal(resolveAccessRequest(request.id, { ok: true, account: "other" }), false);
});

test("отказ пользователя доходит до инструмента без ошибки", async () => {
  const { request, answer } = requestAccess(base);
  assert.equal(resolveAccessRequest(request.id, { ok: false, cancelled: true }), true);
  assert.deepEqual(await answer, { ok: false, cancelled: true });
  assert.equal(findAccessRequest(request.id), null);
});

test("без ответа запрос истекает сам и перестаёт ждать", async () => {
  // Таймер ожидания не держит процесс живым (unref): в бою его держит сам запуск, а тесту нужен
  // собственный keep-alive, иначе раннер решит, что событий больше нет.
  const keepAlive = setInterval(() => {}, 5);
  try {
    const { request, answer } = requestAccess({ ...base, timeoutMs: 20 });
    const resolution = await answer;
    assert.equal(resolution.ok, false);
    assert.match("error" in resolution ? resolution.error : "", /не ввёл ключи/);
    assert.equal(findAccessRequest(request.id), null);
  } finally {
    clearInterval(keepAlive);
  }
});

test("остановка запуска закрывает ожидание, а не оставляет висящую карточку", async () => {
  const controller = new AbortController();
  const { request, answer } = requestAccess({ ...base, signal: controller.signal });
  controller.abort();
  const resolution = await answer;
  assert.equal(resolution.ok, false);
  assert.match("error" in resolution ? resolution.error : "", /остановлен/);
  assert.equal(findAccessRequest(request.id), null);
});

test("уже остановленный запуск не оставляет запрос ждать", async () => {
  const controller = new AbortController();
  controller.abort();
  const { request, answer } = requestAccess({ ...base, signal: controller.signal });
  assert.equal(findAccessRequest(request.id), null);
  assert.equal((await answer).ok, false);
});

test("неизвестный идентификатор не разрешается", () => {
  assert.equal(resolveAccessRequest("нет-такого", { ok: false, cancelled: true }), false);
  assert.equal(findAccessRequest("нет-такого"), null);
});

test("таймаут доступа — десять минут по умолчанию и не меньше пяти секунд из переменной", () => {
  const previous = process.env.ACCESS_REQUEST_TIMEOUT_MS;
  try {
    delete process.env.ACCESS_REQUEST_TIMEOUT_MS;
    assert.equal(accessRequestTimeoutMs(), 600_000);
    process.env.ACCESS_REQUEST_TIMEOUT_MS = "1000";
    assert.equal(accessRequestTimeoutMs(), 600_000);
    process.env.ACCESS_REQUEST_TIMEOUT_MS = "45000";
    assert.equal(accessRequestTimeoutMs(), 45_000);
  } finally {
    if (previous === undefined) delete process.env.ACCESS_REQUEST_TIMEOUT_MS;
    else process.env.ACCESS_REQUEST_TIMEOUT_MS = previous;
  }
});
