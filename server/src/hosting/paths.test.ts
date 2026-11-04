import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureSiteLayout,
  hostingCurrentLink,
  hostingReleaseDir,
  readCurrentReleaseId,
  removeCurrent,
  removeSiteDirectory,
  renameSiteDirectory,
  switchCurrent,
} from "./paths.js";

const slug = "a1b2c3d4e5f6";
const release = "11111111-2222-3333-4444-555555555555";

test("current — относительная ссылка на releases/<id>, switch атомарен и возвращает предыдущий", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-paths-"));
  const data = path.join(root, "data");
  process.env.WEBNESTDEV_DATA_DIR = data;
  process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));

  await ensureSiteLayout(slug, path.join(root, "sites"));
  const first = hostingReleaseDir(slug, release, path.join(root, "sites"));
  await mkdir(first, { recursive: true });
  await writeFile(path.join(first, "index.html"), "one");

  const previous = await switchCurrent(slug, release, path.join(root, "sites"));
  assert.equal(previous, null);
  assert.equal(await readCurrentReleaseId(slug, path.join(root, "sites")), release);

  const secondId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const second = hostingReleaseDir(slug, secondId, path.join(root, "sites"));
  await mkdir(second, { recursive: true });
  assert.equal(await switchCurrent(slug, secondId, path.join(root, "sites")), release);
  assert.equal(await readCurrentReleaseId(slug, path.join(root, "sites")), secondId);

  await removeCurrent(slug, path.join(root, "sites"));
  assert.equal(await readCurrentReleaseId(slug, path.join(root, "sites")), null);
});

test("switch не создаёт current, если каталога релиза нет", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-paths-"));
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  const sites = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensureSiteLayout(slug, sites);
  await assert.rejects(() => switchCurrent(slug, "deadbeef-dead-beef-dead-beefdeadbeef", sites), /не найден/);
  assert.equal(await readCurrentReleaseId(slug, sites), null);
});

test("удаление каталога сайта не выходит за SITES_DIR", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-paths-"));
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  const sites = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensureSiteLayout(slug, sites);
  await removeSiteDirectory(slug, sites);
  assert.equal(await readCurrentReleaseId(slug, sites), null);
  await assert.rejects(() => removeSiteDirectory("../outside", sites), /slug/);
});

test("переименование каталога переносит релизы и относительный current", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-paths-"));
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  const sites = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensureSiteLayout(slug, sites);
  const dir = hostingReleaseDir(slug, release, sites);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), "renamed");
  await switchCurrent(slug, release, sites);

  assert.equal(await renameSiteDirectory(slug, "my-site", sites), true);
  assert.equal(await readCurrentReleaseId("my-site", sites), release);
  await ensureSiteLayout("another-site", sites);
  await assert.rejects(() => renameSiteDirectory(slug, "another-site", sites), /Каталог/);
});

test("current, указывающий за пределы releases, отвергается", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-paths-"));
  process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
  const sites = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));
  await ensureSiteLayout(slug, sites);
  const { symlink, unlink } = await import("node:fs/promises");
  const link = hostingCurrentLink(slug, sites);
  await symlink("../../data", link);
  await assert.rejects(() => readCurrentReleaseId(slug, sites), /releases/);
  await unlink(link);
});
