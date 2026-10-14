import test from "node:test";
import assert from "node:assert/strict";
import { QueueAbortedError } from "../concurrency.js";
import { ACCOUNT_BUSY_CODE,AccountBusyError,accountRunCount,runQueueStats,runWithRunSlot } from "./run-limiter.js";

/** The limit is read from the environment on every call, so a test can pin it. */
function withLimit(limit: string) {
  const previous = process.env.AGENT_MAX_CONCURRENT_RUNS;
  process.env.AGENT_MAX_CONCURRENT_RUNS = limit;
  return () => {
    if (previous === undefined) delete process.env.AGENT_MAX_CONCURRENT_RUNS;
    else process.env.AGENT_MAX_CONCURRENT_RUNS = previous;
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const signal = () => new AbortController().signal;

test("a run that arrives while the host is busy waits, and the caller is told", async () => {
  const restore = withLimit("1");
  try {
    const holding = deferred();
    const started: string[] = [];
    const waiting: number[] = [];
    const first = runWithRunSlot(async () => { started.push("первый"); await holding.promise; }, { signal: signal() });
    await tick();
    const second = runWithRunSlot(async () => { started.push("второй"); }, {
      signal: signal(),
      onQueued: value => waiting.push(value),
    });
    await tick();

    assert.deepEqual(started, ["первый"], "второй запуск не начинается, пока первый держит место");
    assert.deepEqual(waiting, [1], "пользователю сообщают, что он в очереди");
    assert.equal(runQueueStats().active, 1);

    holding.resolve();
    await first;
    await second;
    assert.deepEqual(started, ["первый", "второй"]);
    assert.equal(runQueueStats().active, 0, "после обоих запусков место свободно");
    assert.equal(runQueueStats().queued, 0);
  } finally {
    restore();
  }
});

test("a failed run still releases its place", async () => {
  const restore = withLimit("1");
  try {
    await assert.rejects(runWithRunSlot(async () => { throw new Error("прогон упал"); }, { signal: signal() }), /прогон упал/);
    assert.equal(runQueueStats().active, 0, "упавший запуск не должен держать место навсегда");

    let ran = false;
    await runWithRunSlot(async () => { ran = true; }, { signal: signal() });
    assert.equal(ran, true, "следующий запуск не ждёт освободившегося места");
  } finally {
    restore();
  }
});

test("cancelling while queued frees the place for the next run", async () => {
  const restore = withLimit("1");
  try {
    const holding = deferred();
    const first = runWithRunSlot(async () => { await holding.promise; }, { signal: signal() });
    await tick();

    const controller = new AbortController();
    const queued = runWithRunSlot(async () => "не должно выполниться", { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, error => error instanceof QueueAbortedError);

    holding.resolve();
    await first;
    assert.equal(runQueueStats().active, 0);
    assert.equal(runQueueStats().queued, 0, "отменённый запрос не остался в очереди");
    assert.equal(await runWithRunSlot(async () => "ок", { signal: signal() }), "ок");
  } finally {
    restore();
  }
});

test("one account runs one agent at a time, even with a free place on the host", async () => {
  const restore = withLimit("4");
  try {
    const holding = deferred();
    const first = runWithRunSlot(async () => { await holding.promise; }, { signal: signal(), userId: "аккаунт-1" });
    await tick();
    assert.equal(accountRunCount("аккаунт-1"), 1);
    assert.equal(runQueueStats().active, 1, "место на хосте свободно — но аккаунт уже работает");

    const error = await runWithRunSlot(async () => "не должно выполниться", { signal: signal(), userId: "аккаунт-1" }).then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof AccountBusyError, "второй запуск того же аккаунта отклонён");
    assert.equal((error as AccountBusyError).code, ACCOUNT_BUSY_CODE);
    assert.equal(runQueueStats().queued, 0, "второй запуск не встал в очередь");

    holding.resolve();
    await first;
    assert.equal(accountRunCount("аккаунт-1"), 0, "после завершения аккаунт снова свободен");
    assert.equal(await runWithRunSlot(async () => "ок", { signal: signal(), userId: "аккаунт-1" }), "ок");
  } finally {
    restore();
  }
});

test("another account runs in parallel, and a failed run frees its own account", async () => {
  const restore = withLimit("4");
  try {
    const holding = deferred();
    const first = runWithRunSlot(async () => { await holding.promise; }, { signal: signal(), userId: "аккаунт-1" });
    await tick();

    let secondRan = false;
    await runWithRunSlot(async () => { secondRan = true; }, { signal: signal(), userId: "аккаунт-2" });
    assert.equal(secondRan, true, "другой аккаунт не ждёт чужой запуск");

    await assert.rejects(
      runWithRunSlot(async () => { throw new Error("прогон упал"); }, { signal: signal(), userId: "аккаунт-3" }),
      /прогон упал/,
    );
    assert.equal(accountRunCount("аккаунт-3"), 0, "упавший запуск не держит аккаунт занятым");

    holding.resolve();
    await first;
    assert.equal(accountRunCount("аккаунт-1"), 0);
  } finally {
    restore();
  }
});

test("a free host does not announce a queue", async () => {
  const restore = withLimit("1");
  try {
    let announced = 0;
    const result = await runWithRunSlot(async () => "готово", { signal: signal(), onQueued: () => { announced++; } });
    assert.equal(result, "готово");
    assert.equal(announced, 0, "очереди нет — сообщать нечего");
    assert.equal(runQueueStats().active, 0);
  } finally {
    restore();
  }
});

test("a higher limit runs the configured number of agents at once", async () => {
  const restore = withLimit("2");
  try {
    const firstHolding = deferred();
    const secondHolding = deferred();
    const first = runWithRunSlot(async () => { await firstHolding.promise; }, { signal: signal() });
    const second = runWithRunSlot(async () => { await secondHolding.promise; }, { signal: signal() });
    await tick();
    assert.equal(runQueueStats().active, 2, "два запуска идут параллельно при лимите 2");

    let thirdStarted = false;
    const third = runWithRunSlot(async () => { thirdStarted = true; }, { signal: signal() });
    await tick();
    assert.equal(thirdStarted, false, "третий ждёт, пока лимит занят");

    firstHolding.resolve();
    secondHolding.resolve();
    await Promise.all([first, second, third]);
    assert.equal(thirdStarted, true);
    assert.equal(runQueueStats().active, 0);
  } finally {
    restore();
  }
});
