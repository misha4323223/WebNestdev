import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

const root = await mkdtemp(path.join(tmpdir(), "webnestdev-account-hosts-"));
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "account-hosts-test";
process.env.HOSTING_PUBLIC_DOMAIN = "host.nestdev.test";
delete process.env.DATABASE_URL;

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { createSite } = await import("../hosting/site-store.js");
const { registerAccountHostRoutes } = await import("./account-hosts.js");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("хосты аккаунта показывают только свои сайты и имя проекта", async () => {
  const owner = await createUser("hosts-owner@example.test", "hosts-password-123");
  const stranger = await createUser("hosts-stranger@example.test", "hosts-password-123");
  const project = await createProject("Сайт владельца", undefined, owner.id);
  await createSite({
    projectId: project.id,
    userId: owner.id,
    nodeId: "account-hosts-test",
    slug: "owner-site",
  });

  const app = Fastify();
  await app.register(cookie);
  await registerAccountHostRoutes(app);
  await app.ready();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/account/hosts",
      headers: { cookie: "webnestdev_session=" + (await createSession(owner.id)).id },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { domain: string; hosts: Array<Record<string, unknown>> };
    assert.equal(body.domain, "host.nestdev.test");
    assert.equal(body.hosts.length, 1);
    assert.equal(body.hosts[0]?.projectName, "Сайт владельца");
    assert.equal(body.hosts[0]?.slug, "owner-site");
    assert.equal(body.hosts[0]?.status, "draft");
    assert.equal(body.hosts[0]?.url, null);
    assert.deepEqual(body.hosts[0]?.customDomains, []);

    const foreign = await app.inject({
      method: "GET",
      url: "/api/account/hosts",
      headers: { cookie: "webnestdev_session=" + (await createSession(stranger.id)).id },
    });
    assert.equal(foreign.statusCode, 200);
    assert.deepEqual(foreign.json().hosts, []);
  } finally {
    await app.close();
  }
});
