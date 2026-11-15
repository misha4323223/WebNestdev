import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectHaChecks, readHaStatuses } from "./ha.js";
import { HEALTH_THRESHOLDS } from "./thresholds.js";

const now = Date.parse("2026-11-15T12:00:00.000Z");

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ha-health-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeStatus(dir: string, node: string, value: Record<string, unknown>) {
  await writeFile(path.join(dir, `ha-status-${node}.json`), JSON.stringify(value), "utf8");
}

const primary = {
  node: "node-1",
  updatedAtUnix: Math.floor(now / 1000),
  role: "primary",
  phase: "passive",
  replicationStreams: 1,
  replicationLagBytes: 0,
  archiveReady: true,
};

const standby = {
  node: "node-2",
  updatedAtUnix: Math.floor(now / 1000),
  role: "standby",
  phase: "passive",
  replicationStreams: null,
  replicationLagBytes: null,
  walReceiverStatus: "streaming",
  archiveReady: true,
};

test("без HA-файлов проверки не добавляются", async () => {
  await withDir(async dir => {
    assert.deepEqual(await readHaStatuses(dir), [null, null]);
    assert.deepEqual(await collectHaChecks(now, dir), []);
  });
});

test("свежая пара primary/standby проходит все проверки", async () => {
  await withDir(async dir => {
    await writeStatus(dir, "node-1", primary);
    await writeStatus(dir, "node-2", standby);
    const checks = await collectHaChecks(now, dir);
    assert.deepEqual(checks.map(check => check.id), ["replication", "standby", "controller"]);
    assert.ok(checks.every(check => check.ok === true), JSON.stringify(checks));
  });
});

test("лаг больше порога — тревога репликации", async () => {
  await withDir(async dir => {
    await writeStatus(dir, "node-1", {
      ...primary,
      replicationLagBytes: HEALTH_THRESHOLDS.replicationLagBytes + 1,
    });
    await writeStatus(dir, "node-2", standby);
    const replication = (await collectHaChecks(now, dir)).find(check => check.id === "replication")!;
    assert.equal(replication.ok, false);
    assert.equal(replication.value, HEALTH_THRESHOLDS.replicationLagBytes + 1);
  });
});

test("нет streaming-реплики — тревога, а не нулевой лаг", async () => {
  await withDir(async dir => {
    await writeStatus(dir, "node-1", { ...primary, replicationStreams: 0, replicationLagBytes: 0 });
    await writeStatus(dir, "node-2", standby);
    const replication = (await collectHaChecks(now, dir)).find(check => check.id === "replication")!;
    assert.equal(replication.ok, false);
    assert.match(replication.detail ?? "", /streaming/);
  });
});

test("старый снимок standby не считается живой нодой", async () => {
  await withDir(async dir => {
    await writeStatus(dir, "node-1", primary);
    await writeStatus(dir, "node-2", {
      ...standby,
      updatedAtUnix: Math.floor(now / 1000) - HEALTH_THRESHOLDS.haStatusMaxAgeSeconds - 1,
    });
    const checks = await collectHaChecks(now, dir);
    assert.equal(checks.find(check => check.id === "standby")!.ok, false);
    assert.equal(checks.find(check => check.id === "controller")!.ok, false);
    assert.match(checks.find(check => check.id === "standby")!.detail ?? "", /node-2/);
  });
});

test("WAL-архив не готов — тревога контроллера", async () => {
  await withDir(async dir => {
    await writeStatus(dir, "node-1", { ...primary, archiveReady: false });
    await writeStatus(dir, "node-2", standby);
    const controller = (await collectHaChecks(now, dir)).find(check => check.id === "controller")!;
    assert.equal(controller.ok, false);
    assert.match(controller.detail ?? "", /WAL-архив/);
  });
});

test("фаза failed поднимает тревогу контроллера", async () => {
  await withDir(async dir => {
    await writeStatus(dir, "node-1", primary);
    await writeStatus(dir, "node-2", { ...standby, phase: "failed" });
    const controller = (await collectHaChecks(now, dir)).find(check => check.id === "controller")!;
    assert.equal(controller.ok, false);
    assert.match(controller.detail ?? "", /failed: node-2/);
  });
});
