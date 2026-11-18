import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "webnestdev-site-quota-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");

const store = await import("./site-store.js");
const { assertHostingSiteSlot } = await import("./site-quota.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

test("на «Старте» можно держать только один сайт", async () => {
  await store.resetHostingJsonStore();
  await store.createSite({ projectId: "free-project-1", userId: "free-user", nodeId: "node-a" });
  assert.equal(await store.countSitesForUser("free-user"), 1);
  await assert.rejects(
    () => assertHostingSiteSlot("free-user", "free"),
    error => error instanceof Error && "code" in error && (error as { code: string }).code === "HOSTING_SITE_LIMIT",
  );
});

test("удалённый сайт освобождает место на «Старте»", async () => {
  await store.resetHostingJsonStore();
  const site = await store.createSite({ projectId: "free-project-2", userId: "free-user-2", nodeId: "node-a" });
  await store.markSiteDeleted(site.id);
  assert.equal(await store.countSitesForUser("free-user-2"), 0);
  await assert.doesNotReject(() => assertHostingSiteSlot("free-user-2", "free"));
});

test("на платных тарифах отдельного лимита сайтов нет", async () => {
  await store.resetHostingJsonStore();
  await store.createSite({ projectId: "paid-project-1", userId: "paid-user", nodeId: "node-a" });
  await store.createSite({ projectId: "paid-project-2", userId: "paid-user", nodeId: "node-a" });
  assert.equal(await store.countSitesForUser("paid-user"), 2);
  await assert.doesNotReject(() => assertHostingSiteSlot("paid-user", "pro"));
  await assert.doesNotReject(() => assertHostingSiteSlot("paid-user", "team"));
});
