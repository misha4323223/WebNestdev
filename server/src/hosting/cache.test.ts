import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evictLocalReleases, localReleaseIds } from "./cache.js";
import { ensureSiteLayout, hostingManifestPath, hostingReleaseDir, switchCurrent } from "./paths.js";
import type { HostingRelease, HostingSite } from "./types.js";

const slug = "a1b2c3d4e5f6";
const oldId = "11111111-2222-3333-4444-555555555555";
const activeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const localId = "99999999-8888-7777-6666-555555555555";

function release(id: string, createdAt: string, overrides: Partial<HostingRelease> = {}): HostingRelease {
  return {
    id,
    siteId: "site-1",
    userId: "user-1",
    status: "ready",
    kind: "static-build",
    bytes: 1024,
    storedBytes: 700,
    files: 2,
    sha256: "sha-" + id,
    manifestJson: "{}",
    storageKey: "hosting/releases/" + id + ".tar.gz",
    manifestKey: "hosting/releases/" + id + ".json",
    error: "",
    buildLog: "",
    nodeId: "node-a",
    createdAt,
    readyAt: createdAt,
    activatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const site: HostingSite = {
  id: "site-1",
  userId: "user-1",
  projectId: "project-1",
  slug,
  status: "live",
  activeReleaseId: activeId,
  publishingReleaseId: null,
  nodeId: "node-a",
  lastError: "",
  suspendReason: "",
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  publishedAt: "2026-11-01T09:00:00.000Z",
  unpublishedAt: null,
  suspendedAt: null,
};

async function exists(file: string) {
  return access(file).then(() => true, () => false);
}

test("localReleaseIds оставляет активный и самые новые готовые релизы", () => {
  const releases = [
    release(activeId, "2026-11-03T09:00:00.000Z"),
    release(localId, "2026-11-02T09:00:00.000Z"),
    release(oldId, "2026-11-01T09:00:00.000Z"),
  ];

  assert.deepEqual([...localReleaseIds(releases, activeId, 1)], [activeId]);
  assert.deepEqual([...localReleaseIds(releases, activeId, 2)], [activeId, localId]);
  assert.deepEqual([...localReleaseIds(releases, null, 1)], [activeId]);
  assert.deepEqual(
    [...localReleaseIds([release("building", "2026-11-04T09:00:00.000Z", { status: "building" }), ...releases], activeId, 2)],
    [activeId, localId],
  );
});

test("вытеснение удаляет только архивный неактивный релиз", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hosting-cache-"));
  const sites = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));

  await ensureSiteLayout(slug, sites);
  for (const id of [activeId, localId, oldId]) {
    const dir = hostingReleaseDir(slug, id, sites);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), id);
  }
  await writeFile(hostingManifestPath(slug, oldId, sites), "{}");
  await switchCurrent(slug, activeId, sites);

  const releases = [
    release(activeId, "2026-11-03T09:00:00.000Z"),
    release(localId, "2026-11-02T09:00:00.000Z"),
    release(oldId, "2026-11-01T09:00:00.000Z"),
  ];
  const result = await evictLocalReleases({
    site: { ...site, activeReleaseId: activeId },
    releases,
    activeReleaseId: activeId,
    keep: 2,
    sitesDir: sites,
  });

  assert.deepEqual(result.removed, [oldId]);
  assert.equal(await exists(hostingReleaseDir(slug, activeId, sites)), true);
  assert.equal(await exists(hostingReleaseDir(slug, localId, sites)), true);
  assert.equal(await exists(hostingReleaseDir(slug, oldId, sites)), false);
  assert.equal(await exists(hostingManifestPath(slug, oldId, sites)), false);
});

test("релиз без storageKey и current не вытесняются", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hosting-cache-"));
  const sites = path.join(root, "sites");
  t.after(() => rm(root, { recursive: true, force: true }));

  await ensureSiteLayout(slug, sites);
  for (const id of [localId, oldId]) {
    const dir = hostingReleaseDir(slug, id, sites);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), id);
  }
  await switchCurrent(slug, oldId, sites);

  const result = await evictLocalReleases({
    site: { ...site, activeReleaseId: null },
    releases: [
      release(localId, "2026-11-02T09:00:00.000Z"),
      release(oldId, "2026-11-01T09:00:00.000Z", { storageKey: "" }),
    ],
    activeReleaseId: null,
    keep: 1,
    sitesDir: sites,
  });

  assert.deepEqual(result.removed, []);
  assert.equal(await exists(hostingReleaseDir(slug, localId, sites)), true);
  assert.equal(await exists(hostingReleaseDir(slug, oldId, sites)), true);
});
