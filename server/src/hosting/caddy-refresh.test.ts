import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-caddy-refresh-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");
process.env.CUSTOM_DOMAINS_CADDY_DIR = path.join(root, "caddy");
delete process.env.DATABASE_URL;

const { createSite, beginPublish, finishPublish, unpublishSite } = await import("./site-store.js");
const { createDomainGroup, updateDomain, setCanonical } = await import("./domain-store.js");
const { normalizeCustomDomainGroup } = await import("./domain-name.js");
const { refreshCustomDomainsCaddy } = await import("./caddy-refresh.js");
const { customDomainsCaddyPath } = await import("./caddy-config-writer.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("refresh пишет маршруты, меняет canonical и убирает домен после unpublish", async () => {
  const site = await createSite({ projectId: "project-refresh", userId: "user-refresh", nodeId: "node-refresh", slug: "refresh-site" });
  const started = await beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-refresh" });
  await finishPublish({
    siteId: site.id,
    releaseId: started.release.id,
    userId: site.userId,
    kind: "instant-site",
    bytes: 10,
    files: 1,
    sha256: "refresh",
    manifestJson: "{}",
  });

  const group = normalizeCustomDomainGroup("refresh-example.ru");
  const domains = await createDomainGroup({ siteId: site.id, userId: site.userId, hostnames: group.hostnames });
  for (const domain of domains) {
    await updateDomain(domain.id, { status: "configuring" });
  }

  const first = await refreshCustomDomainsCaddy();
  assert.equal(first.changed, true);
  assert.equal(first.routes, 2);
  const firstConfig = await readFile(customDomainsCaddyPath(), "utf8");
  assert.match(firstConfig, /refresh-example\.ru \{/);
  assert.match(firstConfig, /root \* \/srv\/sites\/refresh-site\/current/);
  assert.match(firstConfig, /www\.refresh-example\.ru \{/);
  assert.match(firstConfig, /redir https:\/\/refresh-example\.ru\{uri\} permanent/);

  await setCanonical(site.id, domains[1]!.id);
  const second = await refreshCustomDomainsCaddy();
  assert.equal(second.changed, true);
  const secondConfig = await readFile(customDomainsCaddyPath(), "utf8");
  assert.match(secondConfig, /redir https:\/\/www\.refresh-example\.ru\{uri\} permanent/);

  await unpublishSite(site.id);
  const third = await refreshCustomDomainsCaddy();
  assert.equal(third.changed, true);
  assert.equal(third.routes, 0);
  const thirdConfig = await readFile(customDomainsCaddyPath(), "utf8");
  assert.doesNotMatch(thirdConfig, /refresh-example\.ru \{/);

  const fourth = await refreshCustomDomainsCaddy();
  assert.equal(fourth.changed, false);
});
