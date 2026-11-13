import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-custom-domains-api-"));
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(root, "sandboxes");
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "api-test-node";
process.env.HOSTING_ENABLED = "1";
process.env.CUSTOM_DOMAINS_ENABLED = "1";
delete process.env.DATABASE_URL;

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { createPayment, markPaymentPaid } = await import("../billing/store.js");
const { createSite, beginPublish, finishPublish } = await import("../hosting/site-store.js");
const { registerHostingRoutes } = await import("./hosting.js");
const { registerCustomDomainRoutes } = await import("./custom-domains.js");
const { verifyDomainGroup } = await import("../hosting/domain-service.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;

async function paidPro(userId: string) {
  const payment = await createPayment({ userId, plan: "pro", amount: 990 });
  await markPaymentPaid(payment.invId);
}

async function fixture(options: { paid?: boolean } = {}) {
  const user = await createUser("domains-" + ++counter + "@example.test", "domains-password-123");
  if (options.paid !== false) await paidPro(user.id);
  const project = await createProject("Сайт с доменом", undefined, user.id);
  const site = await createSite({ projectId: project.id, userId: user.id, nodeId: "api-test-node" });
  const app = Fastify();
  await app.register(cookie);
  await registerHostingRoutes(app);
  await registerCustomDomainRoutes(app);
  await app.ready();
  return {
    app,
    user,
    projectId: project.id,
    siteId: site.id,
    headers: { cookie: "webnestdev_session=" + (await createSession(user.id)).id },
  };
}

function postDomain(app: Awaited<ReturnType<typeof fixture>>["app"], projectId: string, headers: Record<string, string>, payload: object) {
  return app.inject({
    method: "POST",
    url: "/api/projects/" + projectId + "/hosting/domains",
    headers,
    payload,
  });
}

test("на бесплатном тарифе свой домен недоступен", async () => {
  const { app, projectId, headers } = await fixture({ paid: false });
  try {
    const response = await postDomain(app, projectId, headers, { hostname: "example.ru" });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "DOMAIN_PLAN_REQUIRED");
  } finally {
    await app.close();
  }
});

test("создание, чтение, canonical, проверка и удаление домена", async () => {
  const { app, user, projectId, siteId, headers } = await fixture();
  try {
    const created = await postDomain(app, projectId, headers, { hostname: "Example.RU" });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json() as {
      domains: Array<{ id: string; hostname: string; kind: string; isCanonical: boolean; dns: Array<{ type: string; name: string; value: string }> }>;
    };
    assert.deepEqual(body.domains.map(domain => domain.hostname), ["example.ru", "www.example.ru"]);
    assert.equal(body.domains[0].isCanonical, true);
    assert.equal(body.domains[0].dns.some(record => record.type === "TXT" && record.name.startsWith("_nestdev-verify")), true);
    assert.equal(body.domains[0].dns.some(record => record.type === "A" && record.value === "178.236.27.102"), true);
    assert.equal(body.domains[1].dns.some(record => record.type === "CNAME" && record.value === "custom.nestdev.ru."), true);

    const read = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting", headers });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().domains.length, 2);

    const switched = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/domains/" + body.domains[1].id,
      headers,
      payload: { canonical: true },
    });
    assert.equal(switched.statusCode, 200);
    assert.equal(switched.json().domains.length, 2);
    assert.equal(switched.json().domains.find((domain: { hostname: string }) => domain.hostname === "www.example.ru").isCanonical, true);

    const token = await (await import("../hosting/domain-store.js")).getDomainByHostname(body.domains[0].hostname);
    assert.ok(token);
    const resolver = {
      resolveTxt: async () => [["nestdev-verify=" + token.verificationToken]],
      resolve4: async () => ["178.236.27.102"],
      resolve6: async () => [],
      resolveCname: async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); },
      resolveCaa: async () => [],
    };
    const verified = await verifyDomainGroup(siteId, body.domains[0].id, resolver);
    assert.equal(verified.domains.every(domain => domain.status === "configuring"), true);
    assert.equal(verified.checks.every(check => check.txt.allowed && check.traffic.allowed && check.caa.allowed), true);

    const repeated = await postDomain(app, projectId, headers, { hostname: "example.ru" });
    assert.equal(repeated.statusCode, 409);
    assert.equal(repeated.json().code, "DOMAIN_TAKEN");

    const otherProject = await createProject("Второй сайт", undefined, user.id);
    await createSite({ projectId: otherProject.id, userId: user.id, nodeId: "api-test-node" });
    const second = await postDomain(app, otherProject.id, headers, { hostname: "example.ru" });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "DOMAIN_TAKEN");

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/projects/" + projectId + "/hosting/domains/" + body.domains[0].id,
      headers,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting/domains", headers })).json().domains.length, 0);
  } finally {
    await app.close();
  }
});

test("tls-ask не выдаёт сертификат до активации, но разрешает активный custom domain", async () => {
  const { app, user, projectId, siteId, headers } = await fixture();
  try {
    const created = await postDomain(app, projectId, headers, { hostname: "tls-example.ru" });
    assert.equal(created.statusCode, 201);
    const domain = created.json().domains[0] as { id: string; hostname: string };

    const pending = await app.inject({ method: "GET", url: "/api/tls-ask?domain=" + domain.hostname });
    assert.equal(pending.statusCode, 404);

    const domainStore = await import("../hosting/domain-store.js");
    await domainStore.updateDomain(domain.id, { status: "verified" });
    const ownershipOnly = await app.inject({ method: "GET", url: "/api/tls-ask?domain=" + domain.hostname });
    assert.equal(ownershipOnly.statusCode, 404);

    const started = await beginPublish({ siteId, userId: user.id, kind: "instant-site", nodeId: "api-test-node" });
    await finishPublish({
      siteId,
      releaseId: started.release.id,
      userId: user.id,
      kind: "instant-site",
      bytes: 10,
      files: 1,
      sha256: "tls-test",
      manifestJson: "{}",
    });
    await domainStore.updateDomain(domain.id, { status: "configuring" });
    const configuring = await app.inject({ method: "GET", url: "/api/tls-ask?domain=" + domain.hostname });
    assert.equal(configuring.statusCode, 200, configuring.body);
    assert.equal(configuring.json().kind, "custom-domain");

    await domainStore.updateDomain(domain.id, { status: "active", certificateStatus: "active" });
    const active = await app.inject({ method: "GET", url: "/api/tls-ask?domain=" + domain.hostname });
    assert.equal(active.statusCode, 200, active.body);
    assert.equal(active.json().kind, "custom-domain");
  } finally {
    await app.close();
  }
});

test("лимит тарифа считается по домену, а не по apex/www", async () => {
  const { app, projectId, headers } = await fixture();
  try {
    const first = await postDomain(app, projectId, headers, { hostname: "first-example.ru" });
    assert.equal(first.statusCode, 201);
    const second = await postDomain(app, projectId, headers, { hostname: "second-example.ru" });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "DOMAIN_LIMIT");
  } finally {
    await app.close();
  }
});

test("удаление сайта освобождает custom domain", async () => {
  const { app, projectId, siteId, headers } = await fixture();
  try {
    const created = await postDomain(app, projectId, headers, { hostname: "cascade-example.ru" });
    assert.equal(created.statusCode, 201);
    await (await import("../hosting/site-store.js")).markSiteDeleted(siteId);
    const remaining = await (await import("../hosting/domain-store.js")).listDomainsBySite(siteId);
    assert.equal(remaining.length, 0);
  } finally {
    await app.close();
  }
});

test("feature flag выключает API, не удаляя данные", async () => {
  const { app, projectId, headers } = await fixture();
  try {
    const created = await postDomain(app, projectId, headers, { hostname: "flag-example.ru" });
    assert.equal(created.statusCode, 201);
    process.env.CUSTOM_DOMAINS_ENABLED = "0";
    const read = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting/domains", headers });
    assert.equal(read.statusCode, 503);
    assert.equal(read.json().code, "CUSTOM_DOMAINS_DISABLED");
    const blocked = await postDomain(app, projectId, headers, { hostname: "other-example.ru" });
    assert.equal(blocked.statusCode, 503);
  } finally {
    process.env.CUSTOM_DOMAINS_ENABLED = "1";
    await app.close();
  }
});
