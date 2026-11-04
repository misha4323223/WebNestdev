import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * JSON-режим проверяется без базы: это тот же store, который исполняется в разработке и
 * тестах. PostgreSQL-ветка использует те же SQL-поля; её DDL и транзакции проверяются на
 * стенде с DATABASE_URL, потому что поднимать PostgreSQL в unit-тесте было бы дороже, чем
 * польза от такой проверки.
 */
const root = mkdtempSync(path.join(tmpdir(), "webnestdev-hosting-store-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");

const store = await import("./site-store.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("один проект — один сайт; повторное создание возвращает тот же сайт", async () => {
  await store.resetHostingJsonStore();
  const first = await store.createSite({ projectId: "project-a", userId: "user-a", nodeId: "node-a" });
  const second = await store.createSite({ projectId: "project-a", userId: "user-a", nodeId: "node-a" });
  assert.equal(second.id, first.id);
  assert.equal(second.slug, first.slug);
  assert.equal(second.status, "draft");
  assert.equal(second.nodeId, "node-a");
});

test("пользовательский slug проверяется, не повторяется и старый адрес резервируется", async () => {
  await store.resetHostingJsonStore();
  const site = await store.createSite({ projectId: "project-custom", userId: "user-custom", nodeId: "node-a", slug: "my-site" });
  assert.equal(site.slug, "my-site");
  await assert.rejects(
    () => store.createSite({ projectId: "project-custom-2", userId: "user-custom", nodeId: "node-a", slug: "my-site" }),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "SLUG_TAKEN",
  );
  const renamed = await store.renameSiteSlug({ siteId: site.id, expectedSlug: "my-site", slug: "my-new-site" });
  assert.equal(renamed.slug, "my-new-site");
  await assert.rejects(
    () => store.createSite({ projectId: "project-custom-3", userId: "user-custom", nodeId: "node-a", slug: "my-site" }),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "SLUG_TAKEN",
  );
  const back = await store.renameSiteSlug({ siteId: site.id, expectedSlug: "my-new-site", slug: "my-site" });
  assert.equal(back.slug, "my-site");
});

test("второй проект получает отдельный slug и отдельную строку", async () => {
  const first = await store.createSite({ projectId: "project-b", userId: "user-a", nodeId: "node-a" });
  const second = await store.createSite({ projectId: "project-c", userId: "user-a", nodeId: "node-a" });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.slug, second.slug);
});

test("begin/finish: активный релиз один, повторная публикация во время сборки — busy", async () => {
  const site = await store.createSite({ projectId: "project-d", userId: "user-d", nodeId: "node-a" });
  const first = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-a" });
  assert.equal(first.release.status, "building");
  await assert.rejects(
    () => store.beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-a" }),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "SITE_BUSY",
  );

  const finished = await store.finishPublish({
    siteId: site.id,
    releaseId: first.release.id,
    userId: site.userId,
    kind: "instant-site",
    bytes: 1234,
    files: 3,
    sha256: "abc",
    manifestJson: "{}",
    manifestKey: "manifests/test.json",
  });
  assert.equal(finished.site.status, "live");
  assert.equal(finished.site.activeReleaseId, first.release.id);
  assert.equal(finished.site.publishingReleaseId, null);
  assert.equal(finished.release.status, "ready");
  assert.equal(finished.release.bytes, 1234);
});

test("failed build освобождает блокировку и не трогает активный релиз", async () => {
  const site = await store.createSite({ projectId: "project-e", userId: "user-e", nodeId: "node-a" });
  const first = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "static-build", nodeId: "node-a" });
  await store.finishPublish({
    siteId: site.id,
    releaseId: first.release.id,
    userId: site.userId,
    kind: "static-build",
    bytes: 10,
    files: 1,
    sha256: "one",
    manifestJson: "{}",
  });
  const active = (await store.getSite(site.id))?.activeReleaseId;

  const second = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "static-build", nodeId: "node-a" });
  await store.failPublish({
    siteId: site.id,
    releaseId: second.release.id,
    error: "build failed",
    buildLog: "лог сборки",
  });
  const after = await store.getSite(site.id);
  assert.equal(after?.status, "live");
  assert.equal(after?.activeReleaseId, active, "неудачная сборка не меняет активный релиз");
  assert.equal(after?.publishingReleaseId, null);
  assert.equal(after?.lastError, "build failed");
  const releases = await store.listReleases(site.id, 10);
  assert.equal(releases.find(release => release.id === second.release.id)?.status, "failed");
});

test("unpublish/suspend/restore меняют состояние, но не удаляют историю релизов", async () => {
  const site = await store.createSite({ projectId: "project-f", userId: "user-f", nodeId: "node-a" });
  const release = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-a" });
  await store.finishPublish({
    siteId: site.id,
    releaseId: release.release.id,
    userId: site.userId,
    kind: "instant-site",
    bytes: 1,
    files: 1,
    sha256: "x",
    manifestJson: "{}",
  });
  const unpublished = await store.unpublishSite(site.id);
  assert.equal(unpublished?.status, "unpublished");
  const suspended = await store.suspendSite(site.id, "abuse", "2026-11-04T00:00:00.000Z");
  assert.equal(suspended?.status, "suspended");
  assert.equal(suspended?.suspendReason, "abuse");
  const restored = await store.restoreSite(site.id);
  assert.equal(restored?.status, "live");
  assert.equal((await store.listReleases(site.id, 10)).length, 1);
});

test("откат переключает активный релиз на готовый и не удаляет историю", async () => {
  const site = await store.createSite({ projectId: "project-rollback", userId: "user-rollback", nodeId: "node-a" });
  const first = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-a" });
  await store.finishPublish({ siteId: site.id, releaseId: first.release.id, userId: site.userId, kind: "instant-site", bytes: 10, files: 1, sha256: "first", manifestJson: "{}" });
  const second = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-a" });
  await store.finishPublish({ siteId: site.id, releaseId: second.release.id, userId: site.userId, kind: "instant-site", bytes: 20, files: 2, sha256: "second", manifestJson: "{}" });

  const activated = await store.activateRelease({ siteId: site.id, userId: site.userId, releaseId: first.release.id });
  assert.equal(activated.site.activeReleaseId, first.release.id);
  assert.equal(activated.site.status, "live");
  assert.equal((await store.listReleases(site.id, 10)).length, 2);
  await assert.rejects(
    () => store.activateRelease({ siteId: site.id, userId: site.userId, releaseId: "missing-release" }),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "RELEASE_NOT_READY",
  );
});

test("stale building отмечается failed и снимает publishingReleaseId", async () => {
  const site = await store.createSite({ projectId: "project-g", userId: "user-g", nodeId: "node-a" });
  const release = await store.beginPublish({ siteId: site.id, userId: site.userId, kind: "static-build", nodeId: "node-a" });
  const changed = await store.markStaleBuilds(-1);
  assert.ok(changed >= 1);
  const after = await store.getSite(site.id);
  assert.equal(after?.publishingReleaseId, null);
  const found = (await store.listReleases(site.id, 10)).find(item => item.id === release.release.id);
  assert.equal(found?.status, "failed");
});

test("health-срез считает живые сайты и готовые релизы одним проходом", async () => {
  await store.resetHostingJsonStore();
  const published = await store.createSite({ projectId: "project-health-a", userId: "user-health", nodeId: "node-a" });
  const release = await store.beginPublish({ siteId: published.id, userId: published.userId, kind: "instant-site", nodeId: "node-a" });
  await store.finishPublish({
    siteId: published.id,
    releaseId: release.release.id,
    userId: published.userId,
    kind: "instant-site",
    bytes: 100,
    files: 2,
    sha256: "health",
    manifestJson: "{}",
  });

  const failed = await store.createSite({ projectId: "project-health-b", userId: "user-health-2", nodeId: "node-a" });
  const failedRelease = await store.beginPublish({ siteId: failed.id, userId: failed.userId, kind: "static-build", nodeId: "node-a" });
  await store.failPublish({ siteId: failed.id, releaseId: failedRelease.release.id, error: "build failed" });

  const health = await store.hostingHealth();
  assert.equal(health.sites, 2);
  assert.equal(health.live, 1);
  assert.equal(health.releases, 1, "неудачный релиз не считается готовым");
  assert.equal(health.bytes, 100);
  assert.equal(health.failures24h, 1);
  assert.ok(health.lastPublishAt, "время последней публикации заполнено");
});

test("удалённый сайт можно создать заново, но старый адрес не воскресает", async () => {
  const site = await store.createSite({ projectId: "project-h", userId: "user-h", nodeId: "node-a" });
  const oldSlug = site.slug;
  await store.markSiteDeleted(site.id);
  const recreated = await store.createSite({ projectId: "project-h", userId: "user-h", nodeId: "node-a" });
  assert.equal(recreated.id, site.id);
  assert.notEqual(recreated.slug, oldSlug);
  assert.equal(recreated.status, "draft");
  assert.equal(recreated.activeReleaseId, null);
});
