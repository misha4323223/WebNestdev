import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CACHE_MAX_BYTES,
  dependencyCacheMaxBytes,
  directorySizeBytes,
  enforceDependencyCacheQuota,
} from "./cache-quota.js";

const MiB = 1024 * 1024;

async function project(root: string, name: string, bytes: number, usedAt: number) {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "payload.bin"), Buffer.alloc(bytes));
  const date = new Date(usedAt);
  await utimes(dir, date, date);
  return dir;
}

test("потолок берётся из окружения, ноль выключает ограничение", () => {
  const previous = process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES;
  try {
    delete process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES;
    assert.equal(dependencyCacheMaxBytes(), DEFAULT_CACHE_MAX_BYTES);
    process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES = "1048576";
    assert.equal(dependencyCacheMaxBytes(), MiB);
    process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES = "0";
    assert.equal(dependencyCacheMaxBytes(), 0, "ноль — потолка нет");
    process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES = "мусор";
    assert.equal(dependencyCacheMaxBytes(), DEFAULT_CACHE_MAX_BYTES);
  } finally {
    if (previous === undefined) delete process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES;
    else process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES = previous;
  }
});

test("размер каталога считается по обычным файлам, включая вложенные", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-cache-size-"));
  try {
    const dir = await project(root, "p-1", 2 * MiB, Date.now());
    await writeFile(path.join(dir, "extra.txt"), Buffer.alloc(MiB));
    assert.ok((await directorySizeBytes(dir)) >= 3 * MiB);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("кэш под потолком не трогается", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-cache-under-"));
  try {
    await project(root, "p-1", MiB, Date.now() - 10 * 24 * 60 * 60_000);
    const result = await enforceDependencyCacheQuota({ root, maxBytes: 10 * MiB, protectMs: 0 });
    assert.equal(result.removed, 0);
    assert.equal(result.withinLimit, true);
    assert.equal(await stat(path.join(root, "p-1")).then(() => true, () => false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("при превышении уходят самые давно использованные каталоги", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-cache-over-"));
  try {
    const now = Date.now();
    const old = await project(root, "p-old", 2 * MiB, now - 30 * 24 * 60 * 60_000);
    const middle = await project(root, "p-middle", 2 * MiB, now - 10 * 24 * 60 * 60_000);
    const fresh = await project(root, "p-fresh", 2 * MiB, now - 60_000);

    const result = await enforceDependencyCacheQuota({ root, maxBytes: 3 * MiB, protectMs: 0, targetRatio: 0.9 });
    assert.ok(result.removed >= 1);
    assert.equal(await stat(old).then(() => true, () => false), false, "самый старый каталог удалён первым");
    assert.equal(await stat(fresh).then(() => true, () => false), true, "свежий каталог дожил до конца прохода");
    assert.equal(result.withinLimit, true);
    assert.ok(result.remainingBytes <= 3 * MiB);

    // Второй проход при том же потолке обязан опуститься под него: средний каталог ещё жив.
    const second = await enforceDependencyCacheQuota({ root, maxBytes: 3 * MiB, protectMs: 0 });
    assert.ok(second.remainingBytes <= 3 * MiB);
    assert.equal(await stat(middle).then(() => true, () => false) || await stat(fresh).then(() => true, () => false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("свежий каталог защищён, пока установка может его использовать", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-cache-protect-"));
  try {
    const now = Date.now();
    await project(root, "p-active", 4 * MiB, now);
    await project(root, "p-stale", 4 * MiB, now - 48 * 60 * 60_000);

    // Потолок 3 МБ, а один активный каталог уже 4 МБ: убрать его нельзя, значит потолок
    // остаётся превышенным до следующего прохода — и это должно быть видно в отчёте.
    const result = await enforceDependencyCacheQuota({ root, maxBytes: 3 * MiB, protectMs: 60 * 60_000 });
    assert.equal(result.withinLimit, false, "активный каталог не удаляется даже под потолком");
    assert.equal(await stat(path.join(root, "p-active")).then(() => true, () => false), true);
    assert.equal(await stat(path.join(root, "p-stale")).then(() => true, () => false), false, "устаревший убран");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("нулевой потолок выключает уборку", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-cache-off-"));
  try {
    await project(root, "p-1", MiB, Date.now() - 24 * 60 * 60_000);
    const result = await enforceDependencyCacheQuota({ root, maxBytes: 0 });
    assert.equal(result.removed, 0);
    assert.equal(result.withinLimit, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
