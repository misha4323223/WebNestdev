import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

/**
 * API-тест проверяет то, что не видно в store-тестах: проект принадлежит только своему
 * владельцу, сайт создаётся один раз, `unpublished` не рекламирует рабочий URL, а удаление
 * оставляет tombstone в БД. Публикацию здесь не запускаем: для неё нужен Docker и sandbox.
 */
const root = await mkdtemp(path.join(tmpdir(), "webnestdev-hosting-api-"));
process.env.WEBNESTDEV_DATA_DIR = path.join(root, "data");
process.env.WEBNESTDEV_SITES_DIR = path.join(root, "sites");
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(root, "sandboxes");
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_NODE_ID = "api-test-node";
process.env.HOSTING_ENABLED = "1";
delete process.env.DATABASE_URL;

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { createPayment, markPaymentPaid } = await import("../billing/store.js");
const { registerHostingRoutes } = await import("./hosting.js");
const store = await import("../hosting/site-store.js");
const { hostingReleaseDir } = await import("../hosting/paths.js");
const { mkdir, writeFile } = await import("node:fs/promises");

after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;

async function paidPro(userId: string) {
  const payment = await createPayment({ userId, plan: "pro", amount: 990 });
  await markPaymentPaid(payment.invId);
}

async function fixture() {
  const owner = await createUser("hosting-" + ++counter + "@example.test", "hosting-password-123");
  const stranger = await createUser("hosting-other-" + ++counter + "@example.test", "hosting-password-123");
  const project = await createProject("Статический сайт", undefined, owner.id);
  const app = Fastify();
  await app.register(cookie);
  await registerHostingRoutes(app);
  await app.ready();
  return {
    app,
    projectId: project.id,
    ownerId: owner.id,
    ownerHeaders: { cookie: "webnestdev_session=" + (await createSession(owner.id)).id },
    strangerHeaders: { cookie: "webnestdev_session=" + (await createSession(stranger.id)).id },
  };
}

test("SEO: режим сохраняется, чужой проект закрыт, аудит без релиза не запускается", async () => {
  const { app, projectId, ownerHeaders, strangerHeaders } = await fixture();
  try {
    await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });

    const initial = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting/seo", headers: ownerHeaders });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().routingMode, "auto");
    assert.equal(initial.json().effectiveRoutingMode, "static");
    assert.equal(initial.json().sitemapManaged, false);
    assert.equal(initial.json().trailingSlash, "always");
    assert.equal(initial.json().redirects.present, false);
    assert.equal(initial.json().googleVerification, false);

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/seo",
      headers: ownerHeaders,
      payload: { routingMode: "spa" },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().routingMode, "spa");
    assert.equal(patched.json().effectiveRoutingMode, "spa");

    const slash = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/seo",
      headers: ownerHeaders,
      payload: { trailingSlash: "never" },
    });
    assert.equal(slash.statusCode, 200);
    assert.equal(slash.json().trailingSlash, "never");

    const google = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/seo",
      headers: ownerHeaders,
      payload: { googleVerification: "abcDEF_123" },
    });
    assert.equal(google.statusCode, 200);
    assert.equal(google.json().googleVerification, true);
    assert.equal(google.json().googleVerificationReady, false);
    assert.match(google.json().googleVerificationUrl, /\/googleabcDEF_123\.html$/);

    const invalidGoogle = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/seo",
      headers: ownerHeaders,
      payload: { googleVerification: "../evil" },
    });
    assert.equal(invalidGoogle.statusCode, 400);

    const audit = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting/seo/audit", headers: ownerHeaders });
    assert.equal(audit.statusCode, 409);
    assert.equal(audit.json().code, "RELEASE_NOT_READY");

    const foreign = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting/seo", headers: strangerHeaders });
    assert.equal(foreign.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("создание, чтение, снятие с публикации и удаление сайта через API", async () => {
  const { app, projectId, ownerHeaders } = await fixture();
  try {
    const created = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(created.statusCode, 201);
    const site = created.json().site as { id: string; slug: string; status: string; url: string | null };
    assert.equal(site.status, "draft");
    assert.equal(site.url, null);
    assert.match(site.slug, /^[a-f0-9]{12}$/);

    const read = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().enabled, true);
    assert.equal(read.json().site.slug, site.slug);
    assert.deepEqual(read.json().releases, []);

    const repeated = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().site.id, site.id);

    const unpublished = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting/unpublish", headers: ownerHeaders });
    assert.equal(unpublished.statusCode, 200);
    assert.equal(unpublished.json().status, "unpublished");
    assert.equal(unpublished.json().url, null);

    const deleted = await app.inject({ method: "DELETE", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().deleted, true);

    const afterDelete = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(afterDelete.statusCode, 200);
    assert.equal(afterDelete.json().site.status, "deleted");
  } finally {
    await app.close();
  }
});

test("на бесплатном тарифе второй сайт не создаётся", async () => {
  const { app, projectId, ownerId, ownerHeaders } = await fixture();
  try {
    const first = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(first.statusCode, 201);
    const other = await createProject("Второй сайт", undefined, ownerId);
    const second = await app.inject({ method: "POST", url: "/api/projects/" + other.id + "/hosting", headers: ownerHeaders });
    assert.equal(second.statusCode, 403);
    assert.equal(second.json().code, "HOSTING_SITE_LIMIT");
  } finally {
    await app.close();
  }
});

test("GET /hosting описывает статику с функциями и тарифный gate", async () => {
  const { app, projectId, ownerHeaders } = await fixture();
  try {
    const dir = path.join(process.env.WEBNESTDEV_SANDBOX_DIR!, projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<h1>Статика</h1>");
    await writeFile(path.join(dir, "nestdev.functions.json"), JSON.stringify({
      version: 1,
      runtime: "node",
      functions: [{
        name: "hello",
        path: "/api/hello",
        methods: ["GET"],
        handler: "functions/hello.ts#handler",
      }],
      jobs: [{
        name: "nightly",
        handler: "functions/nightly.ts#handler",
      }],
    }));

    const read = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    assert.equal(read.statusCode, 200);
    const project = read.json().project as {
      kind: string; label: string; functions: number; jobs: number; canPublish: boolean; reason: string;
    };
    assert.equal(project.kind, "static-functions");
    assert.equal(project.label, "Статика + функции");
    assert.equal(project.functions, 1);
    assert.equal(project.jobs, 1);
    // В тестовом окружении у владельца бесплатный тариф: функции и задания должны блокировать кнопку.
    assert.equal(project.canPublish, false);
    assert.match(project.reason, /Премиум|недоступны/);
  } finally {
    await app.close();
  }
});

test("пользователь выбирает адрес сайта и может переименовать его", async () => {
  const { app, projectId, ownerId, ownerHeaders, strangerHeaders } = await fixture();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/hosting",
      headers: ownerHeaders,
      payload: { slug: "my-site" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().site.slug, "my-site");

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/slug",
      headers: ownerHeaders,
      payload: { slug: "https://My-New-Site.host.nestdev.ru/" },
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().slug, "my-new-site");

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/slug",
      headers: ownerHeaders,
      payload: { slug: "ab" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, "INVALID_SLUG");

    const foreign = await app.inject({
      method: "PATCH",
      url: "/api/projects/" + projectId + "/hosting/slug",
      headers: strangerHeaders,
      payload: { slug: "stolen-site" },
    });
    assert.equal(foreign.statusCode, 404);

    // Второй сайт проверяет конфликт slug, а не лимит «Старта»: владельцу нужен платный тариф.
    await paidPro(ownerId);
    const other = await createProject("Другой сайт", undefined, ownerId);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/projects/" + other.id + "/hosting",
      headers: ownerHeaders,
      payload: { slug: "my-site" },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, "SLUG_TAKEN");
  } finally {
    await app.close();
  }
});

test("откат на готовый релиз переключает current и active_release_id", async () => {
  const { app, projectId, ownerId, ownerHeaders } = await fixture();
  try {
    const created = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting", headers: ownerHeaders });
    const site = created.json().site as { id: string; slug: string };
    const makeRelease = async () => {
      const started = await store.beginPublish({ siteId: site.id, userId: ownerId, kind: "instant-site", nodeId: "api-test-node" });
      const dir = hostingReleaseDir(site.slug, started.release.id, process.env.WEBNESTDEV_SITES_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.html"), "release " + started.release.id);
      await store.finishPublish({
        siteId: site.id,
        releaseId: started.release.id,
        userId: ownerId,
        kind: "instant-site",
        bytes: 20,
        files: 1,
        sha256: started.release.id,
        manifestJson: "{}",
      });
      return started.release.id;
    };
    const first = await makeRelease();
    const second = await makeRelease();

    const rolledBack = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/hosting/releases/" + first + "/rollback",
      headers: ownerHeaders,
    });
    assert.equal(rolledBack.statusCode, 200);
    assert.equal(rolledBack.json().site.activeReleaseId, first);
    assert.equal(rolledBack.json().release.id, first);
    assert.notEqual(first, second);
  } finally {
    await app.close();
  }
});

test("чужой проект не виден даже при знании его id", async () => {
  const { app, projectId, strangerHeaders } = await fixture();
  try {
    const read = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/hosting", headers: strangerHeaders });
    assert.equal(read.statusCode, 404);
    const created = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/hosting", headers: strangerHeaders });
    assert.equal(created.statusCode, 404);
  } finally {
    await app.close();
  }
});
