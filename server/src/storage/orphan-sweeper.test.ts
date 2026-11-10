import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { orphanRetentionHours, sweepOrphanProjects } from "./orphan-sweeper.js";

const LIVE = "11111111-1111-4111-8111-111111111111";
const DEAD = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";
const HOUR = 60 * 60 * 1000;

async function workspace() {
  return mkdtemp(path.join(tmpdir(), "orphan-sweeper-"));
}

async function makeDir(root: string, name: string, ageMs: number, fileBytes = 0) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  if (fileBytes > 0) await writeFile(path.join(dir, "index.js"), "x".repeat(fileBytes));
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

test("удаляет каталог, которого нет в базе, если он старше порога", async () => {
  const root = await workspace();
  try {
    const dir = await makeDir(root, DEAD, 48 * HOUR, 100);
    const result = await sweepOrphanProjects({
      root,
      now: Date.now(),
      projectIds: async () => new Set([LIVE]),
    });
    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.bytes, 100);
    assert.equal(await exists(dir), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("не трогает каталог живого проекта, сколько бы он ни лежал", async () => {
  const root = await workspace();
  try {
    const dir = await makeDir(root, LIVE, 30 * 24 * HOUR);
    const result = await sweepOrphanProjects({
      root,
      now: Date.now(),
      projectIds: async () => new Set([LIVE]),
    });
    assert.equal(result.removed, 0);
    assert.equal(await exists(dir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("свежий каталог без проекта оставляет до следующего прохода", async () => {
  const root = await workspace();
  try {
    const dir = await makeDir(root, FRESH, 1 * HOUR);
    const result = await sweepOrphanProjects({
      root,
      now: Date.now(),
      projectIds: async () => new Set([LIVE]),
    });
    assert.equal(result.removed, 0);
    assert.equal(await exists(dir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("не удаляет служебные каталоги и страховочные копии восстановления", async () => {
  const root = await workspace();
  try {
    const dirs = [
      await makeDir(root, ".secret-mask", 100 * HOUR),
      await makeDir(root, ".project-backup-" + DEAD, 100 * HOUR),
      await makeDir(root, ".restore-node-1-" + DEAD + "-abcdef", 100 * HOUR),
      await makeDir(root, "archive-abc.tar.gz", 100 * HOUR),
      await makeDir(root, "не-uuid-каталог", 100 * HOUR),
    ];
    const result = await sweepOrphanProjects({
      root,
      now: Date.now(),
      projectIds: async () => new Set([LIVE]),
    });
    assert.equal(result.removed, 0);
    for (const dir of dirs) assert.equal(await exists(dir), true, dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("пустой список проектов отменяет уборку целиком", async () => {
  const root = await workspace();
  try {
    const dir = await makeDir(root, DEAD, 100 * HOUR);
    const result = await sweepOrphanProjects({
      root,
      now: Date.now(),
      projectIds: async () => new Set(),
    });
    assert.equal(result.removed, 0);
    assert.ok(result.aborted);
    assert.equal(await exists(dir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run считает найденное, но ничего не удаляет", async () => {
  const root = await workspace();
  try {
    const dir = await makeDir(root, DEAD, 100 * HOUR, 10);
    const result = await sweepOrphanProjects({
      root,
      now: Date.now(),
      dryRun: true,
      projectIds: async () => new Set([LIVE]),
    });
    assert.equal(result.removed, 1);
    assert.equal(await exists(dir), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("порог читается из SANDBOX_GC_HOURS и не ломается от мусора", () => {
  assert.equal(orphanRetentionHours({}), 24);
  assert.equal(orphanRetentionHours({ SANDBOX_GC_HOURS: "6" }), 6);
  assert.equal(orphanRetentionHours({ SANDBOX_GC_HOURS: "0" }), 24);
  assert.equal(orphanRetentionHours({ SANDBOX_GC_HOURS: "abc" }), 24);
  assert.equal(orphanRetentionHours({ SANDBOX_GC_HOURS: "999999" }), 24 * 30);
});
