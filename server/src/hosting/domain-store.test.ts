import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-domain-store-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.CUSTOM_DOMAINS_ENABLED = "1";
delete process.env.DATABASE_URL;

const store = await import("./domain-store.js");
const { normalizeCustomDomainGroup } = await import("./domain-name.js");

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function create(siteId: string, hostname = "example.ru", maxGroups?: number) {
  const group = normalizeCustomDomainGroup(hostname);
  return store.createDomainGroup({ siteId, userId: "user-a", hostnames: group.hostnames, maxGroups });
}

test("создаёт группу apex/www, считает её одним доменом и не даёт дубль", async () => {
  await store.resetDomainStore();
  const domains = await create("site-a");
  assert.equal(domains.length, 2);
  assert.equal(domains[0].isCanonical, true);
  assert.equal(domains[0].kind, "apex");
  assert.equal(domains[1].isCanonical, false);
  assert.equal(await store.countDomainGroups("site-a"), 1);
  assert.equal((await store.listDomainsBySite("site-a")).length, 2);
  assert.equal((await store.getDomainByHostname("www.example.ru"))?.groupId, domains[0].groupId);

  await assert.rejects(
    () => create("site-b", "www.example.ru"),
    error => Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "DOMAIN_TAKEN"),
  );
});

test("canonical переключается внутри группы, удаление убирает всю пару", async () => {
  await store.resetDomainStore();
  const domains = await create("site-a");
  const switched = await store.setCanonical("site-a", domains[1].id);
  assert.equal(switched.find(domain => domain.id === domains[1].id)?.isCanonical, true);
  assert.equal(switched.find(domain => domain.id === domains[0].id)?.isCanonical, false);

  assert.equal(await store.deleteDomainGroup("site-a", domains[0].id), true);
  assert.equal(await store.countDomainGroups("site-a"), 0);
  assert.equal(await store.getDomain(domains[0].id), null);
});

test("два одновременных создания не превышают лимит", async () => {
  await store.resetDomainStore();
  const results = await Promise.allSettled([
    create("site-race", "one-race.ru", 1),
    create("site-race", "two-race.ru", 1),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal((rejected.reason as { code?: string }).code, "DOMAIN_LIMIT");
  assert.equal(await store.countDomainGroups("site-race"), 1);
});

test("чужая группа не удаляется по domainId", async () => {
  await store.resetDomainStore();
  const domains = await create("site-a");
  assert.equal(await store.deleteDomainGroup("site-other", domains[0].id), false);
  assert.equal(await store.deleteDomainGroup("site-a", "missing"), false);
});

test("перенос проектов меняет владельца доменов", async () => {
  await store.resetDomainStore();
  await create("site-a");
  assert.equal(await store.transferDomainOwners(["site-a"], "user-a", "user-b"), 1);
  assert.equal((await store.listDomainsBySite("site-a")).every(domain => domain.userId === "user-b"), true);
  assert.equal(await store.transferDomainOwners(["site-a"], "user-a", "user-c"), 0);
});
