import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ObjectStore } from "../storage/object-store.js";
import { inspectArtifact } from "./artifact.js";
import { hostingReleaseDir } from "./paths.js";
import { S3ReleaseStore } from "./release-store.js";
import { HostingError, type HostingRelease, type HostingSite } from "./types.js";

/**
 * Этап 8 проверяется без живого S3: фейковый ObjectStore ведёт себя как бакет — принимает
 * файл, отдаёт его обратно и подтверждает размер. Главное здесь — что архив содержит
 * картинки/видео релиза, восстановление сверяет содержимое с записью БД, а удаление
 * убирает оба объекта.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.HOSTING_S3_ENABLED = "0";
const root = await mkdtemp(path.join(tmpdir(), "hosting-release-store-"));
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");

class FakeObjectStore implements ObjectStore {
  readonly prefix = "webnestdev";
  readonly files = new Map<string, Buffer>();

  async putFile(key: string, filePath: string): Promise<number> {
    const data = await readFile(filePath);
    this.files.set(key, data);
    return data.byteLength;
  }

  async getToFile(key: string, filePath: string): Promise<boolean> {
    const data = this.files.get(key);
    if (!data) return false;
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return true;
  }

  async head(key: string) {
    const data = this.files.get(key);
    return data ? { size: data.byteLength } : null;
  }

  async remove(key: string) {
    this.files.delete(key);
  }
}

const site: HostingSite = {
  id: "site-1",
  userId: "user-1",
  projectId: "project-1",
  slug: "a1b2c3d4e5f6",
  status: "live",
  activeReleaseId: null,
  publishingReleaseId: null,
  nodeId: "node-a",
  lastError: "",
  suspendReason: "",
  createdAt: "2026-11-04T09:00:00.000Z",
  updatedAt: "2026-11-04T09:00:00.000Z",
  publishedAt: null,
  unpublishedAt: null,
  suspendedAt: null,
};

const limits = { maxReleaseBytes: 50 * 1024 * 1024, maxFileBytes: 25 * 1024 * 1024, maxFiles: 5_000 };

function releaseFor(id: string, manifest: Awaited<ReturnType<typeof inspectArtifact>>, keys: { storageKey: string; manifestKey: string }): HostingRelease {
  return {
    id,
    siteId: site.id,
    userId: site.userId,
    status: "ready",
    kind: "static-build",
    bytes: manifest.bytes,
    storedBytes: 0,
    files: manifest.filesCount,
    sha256: manifest.sha256,
    manifestJson: JSON.stringify(manifest),
    storageKey: keys.storageKey,
    manifestKey: keys.manifestKey,
    error: "",
    buildLog: "",
    nodeId: site.nodeId,
    createdAt: "2026-11-04T09:00:00.000Z",
    readyAt: "2026-11-04T09:00:00.000Z",
    activatedAt: null,
    deletedAt: null,
  };
}

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeArtifact() {
  const dir = path.join(root, "artifact");
  await mkdir(path.join(dir, "images"), { recursive: true });
  await mkdir(path.join(dir, "media"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<h1>Магазин</h1><img src=\"/images/hero.webp\">");
  // Байты не обязаны быть настоящим WebP: проверяется упаковка и восстановление файлов,
  // а не декодирование картинки. Видео идёт тем же путём.
  await writeFile(path.join(dir, "images", "hero.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]));
  await writeFile(path.join(dir, "media", "intro.mp4"), Buffer.alloc(4096, 7));
  return { dir, manifest: await inspectArtifact(dir, { limits }) };
}

test("релиз уезжает в бакет одним архивом и восстанавливается с картинками и видео", async () => {
  const { dir, manifest } = await makeArtifact();
  const objects = new FakeObjectStore();
  const store = new S3ReleaseStore(objects, "hosting", { sitesDir: process.env.WEBNESTDEV_SITES_DIR!, limits });
  const releaseId = "11111111-1111-4111-8111-111111111111";

  const stored = await store.put({ site, releaseId, dir, manifest });
  assert.equal(stored.storageKey, "hosting/user-1/site-1/releases/" + releaseId + ".tar.gz");
  assert.equal(stored.manifestKey, "hosting/user-1/site-1/releases/" + releaseId + ".json");
  assert.ok(stored.storedBytes > 0);
  assert.equal(objects.files.get(stored.storageKey)?.subarray(0, 2).toString("hex"), "1f8b", "архив должен быть gzip");
  assert.ok(objects.files.has(stored.manifestKey));
  assert.equal(await store.has({ site, release: releaseFor(releaseId, manifest, stored) }), true);

  const release = releaseFor(releaseId, manifest, stored);
  const target = hostingReleaseDir(site.slug, releaseId);
  await rm(dir, { recursive: true, force: true });
  await store.restore({ site, release, dir: target });

  assert.match(await readFile(path.join(target, "index.html"), "utf8"), /Магазин/);
  assert.equal((await readFile(path.join(target, "images", "hero.webp"))).byteLength, 8);
  assert.equal((await readFile(path.join(target, "media", "intro.mp4"))).byteLength, 4096);

  await store.remove({ site, release });
  assert.equal(objects.files.size, 0);
  assert.equal(await store.has({ site, release }), false);
});

test("подменённый или отсутствующий архив не превращается в сайт", async () => {
  const { dir, manifest } = await makeArtifact();
  const objects = new FakeObjectStore();
  const store = new S3ReleaseStore(objects, "hosting", { sitesDir: process.env.WEBNESTDEV_SITES_DIR!, limits });
  const releaseId = "22222222-2222-4222-8222-222222222222";
  const stored = await store.put({ site, releaseId, dir, manifest });
  const release = releaseFor(releaseId, manifest, stored);

  objects.files.set(stored.storageKey, Buffer.from("это не gzip"));
  await assert.rejects(
    () => store.restore({ site, release, dir: hostingReleaseDir(site.slug, releaseId) }),
    error => error instanceof HostingError && error.code === "RELEASE_NOT_READY",
  );

  objects.files.delete(stored.storageKey);
  await assert.rejects(
    () => store.restore({ site, release, dir: hostingReleaseDir(site.slug, releaseId) }),
    error => error instanceof HostingError && error.code === "RELEASE_NOT_READY",
  );

  // Архив цел, но манифест в БД описывает другой релиз — восстановление обязано отказать.
  const other = await makeArtifact();
  await writeFile(path.join(other.dir, "index.html"), "<h1>Другой сайт</h1>");
  const otherManifest = await inspectArtifact(other.dir, { limits });
  const otherStored = await store.put({ site, releaseId, dir: other.dir, manifest: otherManifest });
  const wrong = releaseFor(releaseId, manifest, otherStored);
  await assert.rejects(
    () => store.restore({ site, release: wrong, dir: hostingReleaseDir(site.slug, releaseId) }),
    error => error instanceof HostingError && error.code === "RELEASE_NOT_READY",
  );
});

test("при выключенном бакете хранилище не подставляется молча", async () => {
  const { hostingReleaseStore } = await import("./release-store.js");
  assert.equal(hostingReleaseStore(), null);
});

test("HOSTING_S3_ENABLED=1 без PLATFORM_S3_* даёт явную ошибку, а не тихий диск", async () => {
  const s3Names = ["PLATFORM_S3_ENDPOINT", "PLATFORM_S3_BUCKET", "PLATFORM_S3_ACCESS_KEY_ID", "PLATFORM_S3_SECRET_ACCESS_KEY"];
  const saved = new Map(s3Names.map(name => [name, process.env[name]]));
  const previousMode = process.env.HOSTING_S3_ENABLED;
  try {
    for (const name of s3Names) delete process.env[name];
    process.env.HOSTING_S3_ENABLED = "1";
    const { hostingReleaseStore } = await import("./release-store.js");
    assert.throws(
      () => hostingReleaseStore(),
      error => error instanceof HostingError && error.code === "PUBLISH_FAILED",
    );
  } finally {
    process.env.HOSTING_S3_ENABLED = previousMode;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
