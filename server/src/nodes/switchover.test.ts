import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTIVE_SWITCHOVER_STATES,
  isSwitchoverActive,
  readSwitchover,
  requestSwitchover,
  switchoverFile,
  switchoverStatus,
} from "./switchover.js";

async function withDataDir(run: (dir: string) => Promise<void>) {
  const previous = process.env.WEBNESTDEV_DATA_DIR;
  const dir = await mkdtemp(path.join(os.tmpdir(), "webnestdev-switchover-"));
  process.env.WEBNESTDEV_DATA_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_DATA_DIR;
    else process.env.WEBNESTDEV_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("requestSwitchover writes a requested command and reports its age", async () => {
  await withDataDir(async () => {
    const command = await requestSwitchover({ target: "node-2", requestedBy: "admin@example.test", reason: "освободить node-1" });
    assert.equal(command.state, "requested");
    assert.equal(command.target, "node-2");
    assert.deepEqual(ACTIVE_SWITCHOVER_STATES.includes(command.state), true);

    const stored = JSON.parse(await readFile(switchoverFile(), "utf8")) as { id: string; reason?: string };
    assert.equal(stored.id, command.id);
    assert.equal(stored.reason, "освободить node-1");

    const status = switchoverStatus(await readSwitchover(), Date.parse(command.createdAt) + 1_500);
    assert.equal(status?.ageMs, 1_500);
    assert.equal(status?.requestedBy, "admin@example.test");
  });
});

test("a second request is rejected while the first one is active", async () => {
  await withDataDir(async () => {
    const first = await requestSwitchover({ target: "node-2", requestedBy: "admin@example.test" });
    await assert.rejects(
      () => requestSwitchover({ target: "node-1", requestedBy: "admin@example.test" }),
      new RegExp(first.id),
    );
  });
});

test("concurrent operators cannot create two active requests", async () => {
  await withDataDir(async () => {
    const results = await Promise.allSettled([
      requestSwitchover({ target: "node-2", requestedBy: "first@example.test" }),
      requestSwitchover({ target: "node-1", requestedBy: "second@example.test" }),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
  });
});

test("a terminal operation can be replaced", async () => {
  await withDataDir(async () => {
    const first = await requestSwitchover({ target: "node-2", requestedBy: "admin@example.test" });
    const current = await readSwitchover();
    assert.ok(current);
    await writeFile(switchoverFile(), JSON.stringify({ ...current, state: "promoted" }), "utf8");

    assert.equal(isSwitchoverActive(await readSwitchover()), false);
    const second = await requestSwitchover({ target: "node-1", requestedBy: "admin@example.test" });
    assert.notEqual(second.id, first.id);
    assert.equal(second.state, "requested");
  });
});

test("a malformed command is rejected instead of being silently ignored", async () => {
  await withDataDir(async () => {
    await writeFile(switchoverFile(), JSON.stringify({ action: "switchover", target: "node-2" }), "utf8");
    await assert.rejects(() => readSwitchover(), /не содержит корректной операции/);
  });
});
