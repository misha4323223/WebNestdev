import test from "node:test";
import assert from "node:assert/strict";
import { createLimiter,positiveInt,QueueAbortedError,QueueFullError,QueueTimeoutError } from "./concurrency.js";
import { describeRunLimiter,runQueueStats } from "./agent/run-limiter.js";
import { sandboxQueueStats } from "./sandbox/sandbox-limiter.js";

/** Long enough that a wait is decided by the release, short enough that a test never stalls. */
const WAIT = 1000;

function limiter(overrides: { limit?: number; queueLimit?: number; waitTimeoutMs?: number } = {}) {
  return createLimiter(() => ({
    limit: overrides.limit ?? 1,
    queueLimit: overrides.queueLimit ?? 4,
    waitTimeoutMs: overrides.waitTimeoutMs ?? WAIT,
    busyLabel: "Тест",
  }));
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test("the limit is what runs at once, and a release hands the place to the waiter", async () => {
  const queue = limiter();
  const first = await queue.acquire();
  assert.deepEqual(queue.stats(), { limit: 1, active: 1, queued: 0, queueLimit: 4 });

  let granted = false;
  const waiting = queue.acquire().then(slot => { granted = true; return slot; });
  await tick();
  assert.equal(granted, false, "второй запрос обязан ждать");
  assert.equal(queue.stats().queued, 1);

  first.release();
  const second = await waiting;
  assert.equal(granted, true);
  assert.equal(queue.stats().active, 1, "место перешло ожидающему, а не добавилось");

  second.release();
  assert.equal(queue.stats().active, 0);
});

test("waiters are served in the order they arrived", async () => {
  const queue = limiter();
  const held = await queue.acquire();
  const order: string[] = [];
  const firstWaiting = queue.acquire().then(slot => { order.push("первый"); return slot; });
  const secondWaiting = queue.acquire().then(slot => { order.push("второй"); return slot; });

  held.release();
  (await firstWaiting).release();
  (await secondWaiting).release();
  assert.deepEqual(order, ["первый", "второй"]);
});

test("a full queue answers immediately instead of waiting", async () => {
  const queue = limiter({ queueLimit: 1 });
  const held = await queue.acquire();
  const waiting = queue.acquire();
  await assert.rejects(queue.acquire(), error => {
    assert.ok(error instanceof QueueFullError);
    assert.equal(error.statusCode, 503);
    return true;
  });
  held.release();
  (await waiting).release();
  assert.equal(queue.stats().queued, 0);
});

test("waiting too long answers with a timeout and leaves the queue clean", async () => {
  const queue = limiter({ queueLimit: 2, waitTimeoutMs: 15 });
  const held = await queue.acquire();
  await assert.rejects(queue.acquire(), error => error instanceof QueueTimeoutError);
  assert.equal(queue.stats().queued, 0, "просроченный запрос не остаётся в очереди");
  held.release();
  assert.equal(queue.stats().active, 0);
});

test("an aborted wait releases its place and does not lose capacity", async () => {
  const queue = limiter({ queueLimit: 2 });
  const held = await queue.acquire();
  const controller = new AbortController();
  const waiting = queue.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, error => error instanceof QueueAbortedError);
  assert.equal(queue.stats().queued, 0);

  held.release();
  assert.equal(queue.stats().active, 0, "ёмкость не потерялась вместе с ожиданием");
  const again = await queue.acquire();
  assert.equal(queue.stats().active, 1);
  again.release();
});

test("a signal that is already aborted rejects before taking a place", async () => {
  const queue = limiter();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.acquire(controller.signal), error => error instanceof QueueAbortedError);
  assert.equal(queue.stats().active, 0);
  assert.equal(queue.stats().queued, 0);
});

test("a second release does not invent capacity", async () => {
  const queue = limiter({ queueLimit: 1 });
  const slot = await queue.acquire();
  slot.release();
  slot.release();
  assert.equal(queue.stats().active, 0);

  const running = await queue.acquire();
  const waiting = queue.acquire();
  await tick();
  assert.equal(queue.stats().queued, 1, "второй запрос ждёт: лишнего места не появилось");
  running.release();
  (await waiting).release();
});

test("the run limiter takes its limits from the environment", () => {
  const previous = process.env.AGENT_MAX_CONCURRENT_RUNS;
  try {
    delete process.env.AGENT_MAX_CONCURRENT_RUNS;
    // Runs are cheap — they wait on the model — so the default is several conversations at
    // once; the memory lives in the sandbox container limit, not here.
    assert.equal(runQueueStats().limit, 8, "по умолчанию восемь диалогов одновременно");
    assert.equal(sandboxQueueStats().limit, 2, "и два контейнера песочницы: это и есть лимит памяти");
    process.env.AGENT_MAX_CONCURRENT_RUNS = "4";
    assert.equal(runQueueStats().limit, 4);
    assert.match(describeRunLimiter(), /параллельных запусков агента: 4/);
  } finally {
    if (previous === undefined) delete process.env.AGENT_MAX_CONCURRENT_RUNS;
    else process.env.AGENT_MAX_CONCURRENT_RUNS = previous;
  }
});

test("environment numbers fall back instead of producing an unusable limit", () => {
  assert.equal(positiveInt(undefined, 3), 3);
  assert.equal(positiveInt("5", 3), 5);
  assert.equal(positiveInt("2.7", 3), 2);
  assert.equal(positiveInt("0", 3), 3);
  assert.equal(positiveInt("-2", 3), 3);
  assert.equal(positiveInt("много", 3), 3);
});
