import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupDependencyCache,
  dependencyCacheMarkerPath,
  dependencyCacheMount,
  dependencyEnsureCommand,
  dependencyLockHash,
  ensureDependencyCacheLocal,
} from "./dependency-cache.js";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-dependency-cache-"));
process.env.WEBNESTDEV_PREVIEW_CACHE_DIR = root;
process.env.WEBNESTDEV_PREVIEW_CACHE_HOST_DIR = root;
process.env.WEBNESTDEV_PREVIEW_CACHE = "1";

test("mount points the project's local node_modules at /workspace/node_modules", () => {
  assert.equal(
    dependencyCacheMount({ projectId: "project-a" }),
    path.join(root, "project-a") + ":/workspace/node_modules",
  );
});

test("the install command checks the local marker and only installs on a miss", async () => {
  const project = "command-project";
  const dir = await ensureDependencyCacheLocal(project);
  assert.equal(dir, path.join(root, project));
  const marker = dependencyCacheMarkerPath(project);
  await writeFile(marker, "hash-1", "utf8");

  const command = dependencyEnsureCommand("hash-1");
  assert.match(command, /webnestdev-deps: cached/);
  assert.match(command, /npm install --no-audit --no-fund/);
  assert.match(command, /printf "%s" "hash-1"/);
});

test("the lock hash changes with package.json and is absent without it", async () => {
  const dir = path.join(root, "hash-project");
  await ensureDependencyCacheLocal("hash-project");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { vite: "8" } }), "utf8");
  const first = await dependencyLockHash(dir);
  assert.ok(first);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { vite: "9" } }), "utf8");
  const second = await dependencyLockHash(dir);
  assert.ok(second);
  assert.notEqual(first, second);

  const empty = path.join(root, "no-package");
  await ensureDependencyCacheLocal("no-package");
  assert.equal(await dependencyLockHash(empty), null);
});

test("cleanup removes caches idle for more than 30 days and keeps recent ones", async () => {
  const oldId = "old-project";
  const freshId = "fresh-project";
  await ensureDependencyCacheLocal(oldId);
  await ensureDependencyCacheLocal(freshId);
  await writeFile(dependencyCacheMarkerPath(oldId), "old", "utf8");
  await writeFile(dependencyCacheMarkerPath(freshId), "fresh", "utf8");

  const now = Date.now();
  const old = new Date(now - 31 * 24 * 60 * 60_000);
  await utimes(dependencyCacheMarkerPath(oldId), old, old);
  await utimes(path.join(root, oldId), old, old);

  const result = await cleanupDependencyCache({ root, now, ttlMs: 30 * 24 * 60 * 60_000 });
  assert.equal(result.removed, 1);
  assert.equal((await stat(path.join(root, oldId)).catch(() => null)), null);
  assert.equal((await stat(path.join(root, freshId))).isDirectory(), true);
  assert.equal((await readFile(dependencyCacheMarkerPath(freshId), "utf8")), "fresh");
});

test.after(async () => {
  delete process.env.WEBNESTDEV_PREVIEW_CACHE_DIR;
  delete process.env.WEBNESTDEV_PREVIEW_CACHE_HOST_DIR;
  delete process.env.WEBNESTDEV_PREVIEW_CACHE;
  await rm(root, { recursive: true, force: true });
});
