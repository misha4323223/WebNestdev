import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dependencyCacheNodeModulesDir,
  dependencyLockHash,
  DEPENDENCY_CACHE_MARKER,
} from "./dependency-cache.js";
import { seedStarterLayer, starterLayerRoot } from "./starter-layer.js";

const PACKAGE_JSON = JSON.stringify({ dependencies: { react: "19.2.0" }, devDependencies: { vite: "8.0.0" } }, null, 2);
const OTHER_PACKAGE_JSON = JSON.stringify({ dependencies: { react: "19.2.0", zod: "4.0.0" } }, null, 2);

/** Набор, проект с теми же файлами и уже собранный слой на ноде. */
async function fixture(t: test.TestContext, options: { withLayer?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-layer-"));
  const cache = path.join(root, "cache");
  const kit = path.join(root, "kit");
  const project = path.join(root, "project");
  const previous = {
    cache: process.env.WEBNESTDEV_PREVIEW_CACHE_DIR,
    kit: process.env.WEBNESTDEV_STARTER_KIT_DIR,
    layer: process.env.WEBNESTDEV_STARTER_LAYER_DIR,
    enabled: process.env.WEBNESTDEV_STARTER_LAYER,
  };
  process.env.WEBNESTDEV_PREVIEW_CACHE_DIR = cache;
  process.env.WEBNESTDEV_STARTER_KIT_DIR = kit;
  process.env.WEBNESTDEV_STARTER_LAYER_DIR = path.join(root, "layers");
  delete process.env.WEBNESTDEV_STARTER_LAYER;
  t.after(async () => {
    for (const [key, value] of [
      ["WEBNESTDEV_PREVIEW_CACHE_DIR", previous.cache],
      ["WEBNESTDEV_STARTER_KIT_DIR", previous.kit],
      ["WEBNESTDEV_STARTER_LAYER_DIR", previous.layer],
      ["WEBNESTDEV_STARTER_LAYER", previous.enabled],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(kit, { recursive: true });
  await mkdir(project, { recursive: true });
  for (const dir of [kit, project]) {
    await writeFile(path.join(dir, "package.json"), PACKAGE_JSON, "utf8");
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }), "utf8");
  }
  const hash = await dependencyLockHash(project);
  assert.ok(hash);

  let layerFile = "";
  if (options.withLayer !== false) {
    const modules = path.join(starterLayerRoot(process.env), hash, "node_modules", "react");
    await mkdir(modules, { recursive: true });
    layerFile = path.join(modules, "index.js");
    await writeFile(layerFile, "module.exports = {};\n", "utf8");
    await chmod(layerFile, 0o444);
  }
  return { root, project, hash, layerFile };
}

test("совпавший набор: дерево приезжает жёсткими ссылками и маркер получает хэш проекта", async t => {
  const fixtureData = await fixture(t);
  const dest = dependencyCacheNodeModulesDir("p1");

  const result = await seedStarterLayer({ projectId: "p1", hash: fixtureData.hash });
  assert.equal(result.seeded, true);

  const copied = await lstat(path.join(dest, "react", "index.js"));
  const original = await lstat(fixtureData.layerFile);
  // Жёсткая ссылка: файл один и тот же, второго экземпляра на диске нет.
  assert.equal(copied.ino, original.ino);
  assert.equal(copied.nlink, 2);

  // Маркер — тот же контракт, что у dependencyEnsureCommand: установка не запустится.
  assert.equal(await readFile(path.join(dest, DEPENDENCY_CACHE_MARKER), "utf8"), fixtureData.hash);
  // Каталоги проекта остаются обычными: их можно удалить и в них пишет dev-сервер.
  assert.equal((await stat(dest)).mode & 0o777, 0o775);
  assert.equal((await stat(path.join(dest, "react"))).mode & 0o777, 0o775);
  assert.equal((await stat(path.join(dest, "react", "index.js"))).mode & 0o777, 0o444);
});

test("другие версии проекта: слоя нет, установка идёт обычным путём", async t => {
  const fixtureData = await fixture(t);
  await writeFile(path.join(fixtureData.project, "package.json"), OTHER_PACKAGE_JSON, "utf8");
  const otherHash = await dependencyLockHash(fixtureData.project);
  assert.ok(otherHash);

  const result = await seedStarterLayer({ projectId: "p1", hash: otherHash });
  assert.equal(result.seeded, false);
  assert.match(result.reason ?? "", /не совпадают/);
  await assert.rejects(lstat(dependencyCacheNodeModulesDir("p1")), /ENOENT/);
});

test("слой не собран: тихий отказ, а не ошибка", async t => {
  const fixtureData = await fixture(t, { withLayer: false });
  const result = await seedStarterLayer({ projectId: "p1", hash: fixtureData.hash });
  assert.equal(result.seeded, false);
  assert.match(result.reason ?? "", /не собран/);
});

test("у проекта уже есть своё дерево: его не перезаписываем", async t => {
  const fixtureData = await fixture(t);
  const dest = dependencyCacheNodeModulesDir("p1");
  await mkdir(path.join(dest, "своё"), { recursive: true });
  await writeFile(path.join(dest, "своё", "index.js"), "", "utf8");

  const result = await seedStarterLayer({ projectId: "p1", hash: fixtureData.hash });
  assert.equal(result.seeded, false);
  assert.match(result.reason ?? "", /уже есть/);
  assert.equal((await stat(path.join(dest, "своё", "index.js"))).isFile(), true);
});

test("незавершённая прошлая установка (только маркер) заменяется слоем", async t => {
  const fixtureData = await fixture(t);
  const dest = dependencyCacheNodeModulesDir("p1");
  await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, DEPENDENCY_CACHE_MARKER), "старый-хэш", "utf8");

  const result = await seedStarterLayer({ projectId: "p1", hash: fixtureData.hash });
  assert.equal(result.seeded, true);
  assert.equal(await readFile(path.join(dest, DEPENDENCY_CACHE_MARKER), "utf8"), fixtureData.hash);
});

test("слой можно выключить переменной окружения", async t => {
  const fixtureData = await fixture(t);
  process.env.WEBNESTDEV_STARTER_LAYER = "0";

  const result = await seedStarterLayer({ projectId: "p1", hash: fixtureData.hash });
  assert.deepEqual(result, { seeded: false, reason: "выключено" });
});

test("набор не задан: слоя нет, платформа работает как раньше", async t => {
  const fixtureData = await fixture(t);
  delete process.env.WEBNESTDEV_STARTER_KIT_DIR;

  const result = await seedStarterLayer({ projectId: "p1", hash: fixtureData.hash });
  assert.deepEqual(result, { seeded: false, reason: "набор не задан" });
});
