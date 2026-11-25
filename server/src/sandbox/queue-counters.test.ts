import test from "node:test";
import assert from "node:assert/strict";
import { QueueFullError } from "../concurrency.js";
import {
  noteSandboxQueueFull,
  noteSandboxWaitTimedOut,
  resetSandboxQueueRejections,
  sandboxQueueRejections,
} from "./queue-counters.js";
import { resetSandboxLimiters, withSandboxSlot } from "./sandbox-limiter.js";

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("счётчики отказов начинаются с нуля и считают каждый случай", () => {
  resetSandboxQueueRejections();
  assert.deepEqual(sandboxQueueRejections(), { queueFull: 0, waitTimedOut: 0 });
  noteSandboxQueueFull();
  noteSandboxQueueFull();
  noteSandboxWaitTimedOut();
  assert.deepEqual(sandboxQueueRejections(), { queueFull: 2, waitTimedOut: 1 });
  resetSandboxQueueRejections();
  assert.deepEqual(sandboxQueueRejections(), { queueFull: 0, waitTimedOut: 0 });
});

test("заполненная очередь песочницы считается как queue_full, а место освобождается", async () => {
  const previousLimit = process.env.SANDBOX_MAX_CONCURRENT;
  const previousQueue = process.env.SANDBOX_MAX_QUEUE;
  const previousTimeout = process.env.SANDBOX_QUEUE_TIMEOUT_MS;
  process.env.SANDBOX_MAX_CONCURRENT = "1";
  // Очередь на один запрос: первый держит место, второй ждёт, третий получает отказ — это и есть
  // «свободных мест нет». Таймаут короткий, чтобы просроченное ожидание не тормозило тесты.
  process.env.SANDBOX_MAX_QUEUE = "1";
  process.env.SANDBOX_QUEUE_TIMEOUT_MS = "2000";
  resetSandboxLimiters();
  resetSandboxQueueRejections();
  try {
    const holding = deferred();
    const first = withSandboxSlot(async () => { await holding.promise; });
    await tick();
    const second = withSandboxSlot(async () => "вторая");
    await tick();

    await assert.rejects(withSandboxSlot(async () => "не должно выполниться"), error => error instanceof QueueFullError);
    assert.equal(sandboxQueueRejections().queueFull, 1, "отказ записан в счётчик");

    holding.resolve();
    await first;
    assert.equal(await second, "вторая", "ожидавший получил освободившееся место");
    assert.equal(await withSandboxSlot(async () => "ок"), "ок", "после освобождения места команда проходит");
    assert.equal(sandboxQueueRejections().queueFull, 1, "успешная команда счётчик не увеличивает");
  } finally {
    if (previousLimit === undefined) delete process.env.SANDBOX_MAX_CONCURRENT;
    else process.env.SANDBOX_MAX_CONCURRENT = previousLimit;
    if (previousQueue === undefined) delete process.env.SANDBOX_MAX_QUEUE;
    else process.env.SANDBOX_MAX_QUEUE = previousQueue;
    if (previousTimeout === undefined) delete process.env.SANDBOX_QUEUE_TIMEOUT_MS;
    else process.env.SANDBOX_QUEUE_TIMEOUT_MS = previousTimeout;
    resetSandboxLimiters();
    resetSandboxQueueRejections();
  }
});
