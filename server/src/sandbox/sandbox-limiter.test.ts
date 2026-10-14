import test from "node:test";
import assert from "node:assert/strict";
import { runInSandbox } from "../sandbox-worker.js";
import type { SandboxConfig } from "../sandbox-manager.js";
import { describeSandboxLimiter, sandboxQueueStats, withSandboxSlot } from "./sandbox-limiter.js";

/** The limit is read from the environment on every call, so a test can pin it. */
function withLimit(limit: string) {
  const previous = process.env.SANDBOX_MAX_CONCURRENT;
  process.env.SANDBOX_MAX_CONCURRENT = limit;
  return () => {
    if (previous === undefined) delete process.env.SANDBOX_MAX_CONCURRENT;
    else process.env.SANDBOX_MAX_CONCURRENT = previous;
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test("a command that arrives while every container place is busy waits for one", async () => {
  const restore = withLimit("1");
  try {
    const holding = deferred();
    const started: string[] = [];
    const first = withSandboxSlot(async () => { started.push("первая"); await holding.promise; });
    await tick();
    const second = withSandboxSlot(async () => { started.push("вторая"); });
    await tick();

    assert.deepEqual(started, ["первая"], "второй контейнер не стартует, пока первый держит место");
    assert.equal(sandboxQueueStats().active, 1);

    holding.resolve();
    await first;
    await second;
    assert.deepEqual(started, ["первая", "вторая"]);
    assert.equal(sandboxQueueStats().active, 0, "после обеих команд места свободны");
    assert.equal(sandboxQueueStats().queued, 0);
  } finally {
    restore();
  }
});

test("a failed command releases its container place", async () => {
  const restore = withLimit("1");
  try {
    await assert.rejects(withSandboxSlot(async () => { throw new Error("команда упала"); }), /команда упала/);
    assert.equal(sandboxQueueStats().active, 0, "упавшая команда не держит место навсегда");
    assert.equal(await withSandboxSlot(async () => "ок"), "ок");
  } finally {
    restore();
  }
});

test("several conversations share the container limit instead of running one at a time", async () => {
  const restore = withLimit("2");
  try {
    const firstHolding = deferred();
    const secondHolding = deferred();
    const first = withSandboxSlot(async () => { await firstHolding.promise; });
    const second = withSandboxSlot(async () => { await secondHolding.promise; });
    await tick();
    assert.equal(sandboxQueueStats().active, 2, "два контейнера идут параллельно при лимите 2");

    let thirdStarted = false;
    const third = withSandboxSlot(async () => { thirdStarted = true; });
    await tick();
    assert.equal(thirdStarted, false, "третий ждёт свободного места");

    firstHolding.resolve();
    secondHolding.resolve();
    await Promise.all([first, second, third]);
    assert.equal(thirdStarted, true);
    assert.equal(sandboxQueueStats().active, 0);
  } finally {
    restore();
  }
});

test("the guard really sits on the command path, and a refused command frees its place", async () => {
  // SANDBOX_MODE=none is the one mode where the command path fails before Docker: it proves the
  // slot is taken around the real entry point (`runInSandbox`, the only one every tool uses) and
  // that the release survives the failure.
  const previousMode = process.env.SANDBOX_MODE;
  process.env.SANDBOX_MODE = "none";
  try {
    const config: SandboxConfig = { projectId: "проба", root: process.cwd(), memoryMb: 512, cpuLimit: 1, timeoutMs: 5000 };
    await assert.rejects(runInSandbox(config, "echo привет", config.root), /отключено/);
    assert.equal(sandboxQueueStats().active, 0, "отказанная команда не держит место контейнера");
    assert.equal(await withSandboxSlot(async () => "ок"), "ок");
  } finally {
    if (previousMode === undefined) delete process.env.SANDBOX_MODE;
    else process.env.SANDBOX_MODE = previousMode;
  }
});

test("the sandbox limiter takes its limits from the environment", () => {
  const previous = process.env.SANDBOX_MAX_CONCURRENT;
  try {
    delete process.env.SANDBOX_MAX_CONCURRENT;
    // Two, not one: a container is what costs memory, and one is what made the whole host
    // answer a single user while everyone else waited on an idle conversation.
    assert.equal(sandboxQueueStats().limit, 2);
    process.env.SANDBOX_MAX_CONCURRENT = "5";
    assert.equal(sandboxQueueStats().limit, 5);
    assert.match(describeSandboxLimiter(), /контейнеров песочницы параллельно: 5/);
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_MAX_CONCURRENT;
    else process.env.SANDBOX_MAX_CONCURRENT = previous;
  }
});
