import test from "node:test";
import assert from "node:assert/strict";
import { QueueAbortedError, QueueTimeoutError } from "../concurrency.js";
import { resetSandboxLimiters, withSandboxSlot } from "./sandbox-limiter.js";
import {
  memoryLimitMb,
  reserveSandboxMemory,
  resetSandboxMemoryBudget,
  sandboxMemoryBudgetMb,
  sandboxMemoryStats,
} from "./memory-budget.js";

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetSandboxMemoryBudget();
    });
}

test("бюджет по умолчанию — два контейнера обычного размера, а не отдельное число из воздуха", async () => {
  await withEnv({ SANDBOX_MEMORY_MB: undefined, SANDBOX_MAX_CONCURRENT: undefined, SANDBOX_MEMORY_BUDGET_MB: undefined }, () => {
    assert.equal(sandboxMemoryBudgetMb(), 2048);
    assert.equal(sandboxMemoryStats().limitMb, 2048);
  });
  await withEnv({ SANDBOX_MEMORY_MB: "512", SANDBOX_MAX_CONCURRENT: "3" }, () => {
    assert.equal(sandboxMemoryBudgetMb(), 1536);
  });
  await withEnv({ SANDBOX_MEMORY_BUDGET_MB: "3072" }, () => {
    assert.equal(sandboxMemoryBudgetMb(), 3072, "явный бюджет важнее выведенного");
  });
  await withEnv({ SANDBOX_MEMORY_BUDGET_MB: "10" }, () => {
    assert.equal(sandboxMemoryBudgetMb(), 2048, "слишком маленький бюджет не принимается — остаётся выведенный");
  });
});

test("потолок контейнера читается из docker-строки", () => {
  assert.equal(memoryLimitMb("1024m", 999), 1024);
  assert.equal(memoryLimitMb("1g", 999), 1024);
  assert.equal(memoryLimitMb("512M", 999), 512);
  assert.equal(memoryLimitMb("256", 999), 256);
  assert.equal(memoryLimitMb("мусор", 768), 768, "непонятное значение — обычный размер контейнера");
  assert.equal(memoryLimitMb(undefined, 1024), 1024);
});

test("две резервации по 1 ГБ занимают бюджет, третья ждёт и получает память после освобождения", async () => {
  await withEnv({ SANDBOX_MEMORY_MB: "1024", SANDBOX_MAX_CONCURRENT: "2" }, async () => {
    const first = await reserveSandboxMemory(1024);
    const second = await reserveSandboxMemory(1024);
    assert.deepEqual(sandboxMemoryStats(), { limitMb: 2048, usedMb: 2048, waiting: 0 });

    let thirdStarted = false;
    const thirdPromise = reserveSandboxMemory(1024, { waitMs: 2000 }).then(reservation => {
      thirdStarted = true;
      return reservation;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(thirdStarted, false, "память не выдаётся сверх бюджета");
    assert.equal(sandboxMemoryStats().waiting, 1);

    first.release();
    const third = await thirdPromise;
    assert.equal(thirdStarted, true);
    assert.equal(sandboxMemoryStats().usedMb, 2048, "освобождённое место занял ожидающий");
    first.release();
    assert.equal(sandboxMemoryStats().usedMb, 2048, "двойное освобождение не возвращает память дважды");
    second.release();
    third.release();
    assert.equal(sandboxMemoryStats().usedMb, 0);
  });
});

test("резервация больше бюджета занимает его целиком и не блокирует сама себя", async () => {
  await withEnv({ SANDBOX_MEMORY_BUDGET_MB: "1024" }, async () => {
    const big = await reserveSandboxMemory(4096);
    assert.equal(sandboxMemoryStats().usedMb, 1024);
    const waiting = reserveSandboxMemory(512, { waitMs: 30 });
    await assert.rejects(waiting, (error: unknown) => error instanceof QueueTimeoutError);
    big.release();
    assert.equal(sandboxMemoryStats().usedMb, 0);
  });
});

test("ожидание памяти заканчивается по таймауту и не оставляет занятого места", async () => {
  await withEnv({ SANDBOX_MEMORY_BUDGET_MB: "1024" }, async () => {
    const held = await reserveSandboxMemory(1024);
    await assert.rejects(
      reserveSandboxMemory(1024, { waitMs: 30, label: "Песочница" }),
      (error: unknown) => error instanceof QueueTimeoutError && /Песочница/.test(error.message),
    );
    assert.deepEqual(sandboxMemoryStats(), { limitMb: 1024, usedMb: 1024, waiting: 0 });
    held.release();
  });
});

test("команда песочницы занимает память на время работы и отпускает её", async () => {
  await withEnv({ SANDBOX_MEMORY_BUDGET_MB: "1024" }, async () => {
    resetSandboxLimiters();
    let release!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    const first = withSandboxSlot(async () => { await holding; }, { memoryMb: 1024 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sandboxMemoryStats().usedMb, 1024, "контейнер команды входит в общий бюджет");

    let secondStarted = false;
    const second = withSandboxSlot(async () => { secondStarted = true; }, { memoryMb: 1024 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondStarted, false, "вторая команда ждёт память, а не стартует сверх бюджета");

    release();
    await Promise.all([first, second]);
    assert.equal(secondStarted, true);
    assert.equal(sandboxMemoryStats().usedMb, 0, "после команд бюджет свободен");
  });
});

test("отмена запуска снимает ожидание памяти", async () => {
  await withEnv({ SANDBOX_MEMORY_BUDGET_MB: "1024" }, async () => {
    const held = await reserveSandboxMemory(1024);
    const controller = new AbortController();
    const waiting = reserveSandboxMemory(1024, { signal: controller.signal, waitMs: 5000 });
    controller.abort();
    await assert.rejects(waiting, (error: unknown) => error instanceof QueueAbortedError);
    assert.equal(sandboxMemoryStats().waiting, 0, "отменённое ожидание не остаётся в списке");
    held.release();
  });
});
