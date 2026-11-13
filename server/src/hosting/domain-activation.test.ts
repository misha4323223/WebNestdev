import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-domain-activation-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");
delete process.env.DATABASE_URL;

const { createSite, beginPublish, finishPublish } = await import("./site-store.js");
const { createDomainGroup, listDomainsBySite, updateDomain } = await import("./domain-store.js");
const { normalizeCustomDomainGroup } = await import("./domain-name.js");
const { activateCustomDomains } = await import("./domain-activation.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("TLS-проба активирует домен, а ошибка оставляет issuing для повтора", async () => {
  const site = await createSite({ projectId: "project-activation", userId: "user-activation", nodeId: "node-activation", slug: "activation-site" });
  const started = await beginPublish({ siteId: site.id, userId: site.userId, kind: "instant-site", nodeId: "node-activation" });
  await finishPublish({
    siteId: site.id,
    releaseId: started.release.id,
    userId: site.userId,
    kind: "instant-site",
    bytes: 1,
    files: 1,
    sha256: "activation",
    manifestJson: "{}",
  });
  const group = normalizeCustomDomainGroup("activation-example.ru");
  const domains = await createDomainGroup({ siteId: site.id, userId: site.userId, hostnames: group.hostnames });
  for (const domain of domains) {
    await updateDomain(domain.id, { status: "configuring" });
  }

  const first = await activateCustomDomains({
    probe: async hostname => hostname === "activation-example.ru"
      ? { ok: true, protocol: "TLSv1.3" }
      : { ok: false, error: "certificate is not ready" },
  });
  assert.equal(first.checked, 2);
  assert.equal(first.activated, 1);
  assert.equal(first.failed, 1);
  const afterFirst = await listDomainsBySite(site.id);
  assert.equal(afterFirst.find(domain => domain.hostname === "activation-example.ru")?.status, "active");
  assert.equal(afterFirst.find(domain => domain.hostname === "activation-example.ru")?.certificateStatus, "active");
  const failed = afterFirst.find(domain => domain.hostname === "www.activation-example.ru");
  assert.equal(failed?.status, "issuing_certificate");
  assert.match(failed?.certificateError ?? "", /not ready/);

  const second = await activateCustomDomains({ probe: async () => ({ ok: true }) });
  assert.equal(second.activated, 1);
  assert.equal((await listDomainsBySite(site.id)).every(domain => domain.status === "active"), true);
});
