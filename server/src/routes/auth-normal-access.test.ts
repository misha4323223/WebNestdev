import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * После одобрения Робокассы временный публичный демо-доступ удалён. Гость снова должен
 * получать экран входа, а cookie служебного аккаунта, оставшаяся в браузере проверяющего,
 * не должна открывать сайт.
 *
 * Хранилище и каталог данных выбираются до импорта: auth-store читает их при загрузке.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.NODE_ENV = "test";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "auth-normal-access-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { createSession, createUser, getSession } = await import("../auth/auth-store.js");

async function appWithRoutes() {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app);
  await app.ready();
  return app;
}

test("гость без сессии получает обычный экран входа, а не демо-аккаунт", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  const response = await app.inject({ method: "GET", url: "/api/auth/me" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: false,
    user: null,
    onboarding: { profile: null },
  });
  assert.equal(response.headers["set-cookie"], undefined);
});

test("старая сессия служебного демо-аккаунта отзывается", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  const demo = await createUser("review@webnestdev.local", "retired-demo-password");
  const session = await createSession(demo.id);
  const response = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: "webnestdev_session=" + session.id },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().authenticated, false);
  assert.equal(await getSession(session.id), null);
});

test.after(async () => {
  delete process.env.WEBNESTDEV_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});
