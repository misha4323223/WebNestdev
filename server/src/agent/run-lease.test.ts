import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { acquireRunLease, isProjectRunLeaseActive, setRunLeaseBackendForTests, type RunLeaseBackend } from "./run-lease.js";
import { AccountBusyError, runWithRunSlot } from "./run-limiter.js";

type Held = { runId: string; projectId: string; expiresAt: number };

function memoryLeaseBackend() {
  const held = new Map<string, Held>();
  let heartbeats = 0;
  const backend: RunLeaseBackend = {
    enabled: () => true,
    async tryAcquire(input) {
      const current = held.get(input.userId);
      if (current && current.expiresAt > input.now) return false;
      held.set(input.userId, { runId: input.runId, projectId: input.projectId, expiresAt: input.expiresAt });
      return true;
    },
    async heartbeat(input) {
      const current = held.get(input.userId);
      if (!current || current.runId !== input.runId) return false;
      current.expiresAt = input.expiresAt;
      heartbeats += 1;
      return true;
    },
    async release(input) {
      const current = held.get(input.userId);
      if (current?.runId === input.runId) held.delete(input.userId);
    },
    async projectActive(projectId, now) {
      return [...held.values()].some(lease => lease.projectId === projectId && lease.expiresAt > now);
    },
  };
  return { backend, held, heartbeats: () => heartbeats };
}

const signal = () => new AbortController().signal;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => setRunLeaseBackendForTests(null));

test("аренда не даёт второму процессу запустить тот же аккаунт", async () => {
  const { backend, held } = memoryLeaseBackend();
  setRunLeaseBackendForTests(backend);

  const first = await acquireRunLease("account-1", { signal: signal(), waitMs: 0 });
  assert.equal(first.kind, "acquired");
  assert.equal(held.has("account-1"), true);

  const second = await acquireRunLease("account-1", { signal: signal(), waitMs: 0 });
  assert.equal(second.kind, "busy");

  if (first.kind === "acquired") await first.lease.release();
  assert.equal(held.has("account-1"), false);

  const third = await acquireRunLease("account-1", { signal: signal(), waitMs: 0 });
  assert.equal(third.kind, "acquired");
  if (third.kind === "acquired") await third.lease.release();
});

test("освободившаяся аренда достаётся ожидающему запросу, а не отказу", async () => {
  const { backend } = memoryLeaseBackend();
  setRunLeaseBackendForTests(backend);

  const first = await acquireRunLease("account-1", { signal: signal(), waitMs: 0 });
  assert.equal(first.kind, "acquired");

  const waiting = acquireRunLease("account-1", { signal: signal(), waitMs: 1000 });
  setTimeout(() => {
    if (first.kind === "acquired") void first.lease.release();
  }, 30);

  const second = await waiting;
  assert.equal(second.kind, "acquired");
  if (second.kind === "acquired") await second.lease.release();
});

test("проект занят по общей аренде, пока запуск не отпущен", async () => {
  const { backend } = memoryLeaseBackend();
  setRunLeaseBackendForTests(backend);

  assert.equal(await isProjectRunLeaseActive("project-1"), false);
  const acquired = await acquireRunLease("account-1", { signal: signal(), waitMs: 0, projectId: "project-1" });
  assert.equal(acquired.kind, "acquired");
  assert.equal(await isProjectRunLeaseActive("project-1"), true);
  if (acquired.kind === "acquired") await acquired.lease.release();
  assert.equal(await isProjectRunLeaseActive("project-1"), false);
});

test("закрытое соединение не ждёт аренду и не запускает работу", async () => {
  const { backend } = memoryLeaseBackend();
  setRunLeaseBackendForTests(backend);

  const first = await acquireRunLease("account-1", { signal: signal(), waitMs: 0 });
  assert.equal(first.kind, "acquired");

  const controller = new AbortController();
  const waiting = acquireRunLease("account-1", { signal: controller.signal, waitMs: 1000 });
  setTimeout(() => controller.abort(), 20);
  assert.equal((await waiting).kind, "aborted");

  if (first.kind === "acquired") await first.lease.release();
});

test("heartbeat продлевает аренду, а release идемпотентен", async () => {
  const { backend, heartbeats, held } = memoryLeaseBackend();
  setRunLeaseBackendForTests(backend);

  const acquired = await acquireRunLease("account-1", { signal: signal(), waitMs: 0 });
  assert.equal(acquired.kind, "acquired");
  if (acquired.kind !== "acquired") return;

  await acquired.lease.heartbeat();
  assert.equal(heartbeats(), 1);
  assert.equal(held.has("account-1"), true);

  // Освобождение до истечения TTL — единственный путь, которым аренда снимается сразу.
  await tick(10);
  await acquired.lease.release();
  await acquired.lease.release();
  assert.equal(held.has("account-1"), false);
});

test("лимитер отпускает общую аренду после запуска и по обрыву соединения", async () => {
  const { backend, held } = memoryLeaseBackend();
  setRunLeaseBackendForTests(backend);
  const previousLimit = process.env.AGENT_MAX_CONCURRENT_RUNS;
  const previousWait = process.env.AGENT_ACCOUNT_WAIT_MS;
  process.env.AGENT_MAX_CONCURRENT_RUNS = "4";
  process.env.AGENT_ACCOUNT_WAIT_MS = "0";
  try {
    let release!: () => void;
    const holding = new Promise<void>(resolve => { release = resolve; });
    const first = runWithRunSlot(async () => await holding, { signal: signal(), userId: "account-1" });
    await tick();
    assert.equal(held.has("account-1"), true, "запуск держит общую аренду");

    const second = await runWithRunSlot(async () => "не должно выполниться", { signal: signal(), userId: "account-1" })
      .then(() => null, error => error);
    assert.ok(second instanceof AccountBusyError, "вторая реплика получает отказ по общей аренде");

    release();
    await first;
    assert.equal(held.has("account-1"), false, "после завершения аренда снята");

    const controller = new AbortController();
    const stuck = runWithRunSlot(async () => await new Promise<void>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), {
      signal: controller.signal,
      userId: "account-2",
    });
    await tick();
    controller.abort();
    await assert.rejects(stuck, /aborted/);
    assert.equal(held.has("account-2"), false, "обрыв соединения снимает общую аренду");
  } finally {
    if (previousLimit === undefined) delete process.env.AGENT_MAX_CONCURRENT_RUNS;
    else process.env.AGENT_MAX_CONCURRENT_RUNS = previousLimit;
    if (previousWait === undefined) delete process.env.AGENT_ACCOUNT_WAIT_MS;
    else process.env.AGENT_ACCOUNT_WAIT_MS = previousWait;
  }
});

test("без PostgreSQL аренда выключена, и решение остаётся локальному лимитеру", async () => {
  const { backend } = memoryLeaseBackend();
  setRunLeaseBackendForTests({ ...backend, enabled: () => false });
  assert.equal((await acquireRunLease("account-1", { signal: signal(), waitMs: 0 })).kind, "disabled");
});
