import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Временный публичный демо-доступ: гость без сессии получает отдельный аккаунт, а не экран
 * входа. Проверяется не только выдача, но и возврат: после выключения флага старая cookie
 * демо-аккаунта перестаёт открывать сайт, а реальный пользователь не подменяется демо.
 *
 * Хранилище и каталог данных выбираются до импорта: auth-store читает их при загрузке.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.NODE_ENV = "test";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
delete process.env.WEBNESTDEV_PUBLIC_DEMO;
const root = await mkdtemp(path.join(tmpdir(), "public-demo-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { createSession, createUser } = await import("../auth/auth-store.js");
const { savePlatformEnv } = await import("../platform/platform-env.js");

// Флаг включается тем же путём, что и в панели: значение из каталога, а не переменная оболочки.
await savePlatformEnv({ WEBNESTDEV_PUBLIC_DEMO: "1" });

async function appWithRoutes() {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app);
  await app.ready();
  return app;
}

function sessionCookie(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof value, "string", "публичный режим выдаёт cookie сессии");
  return (value as string).split(";")[0];
}

let demoCookie = "";

test("публичный режим открывает сайт под отдельным демо-аккаунтом", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  const first = await app.inject({ method: "GET", url: "/api/auth/me" });
  assert.equal(first.statusCode, 200);
  const body = first.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.publicDemo, true);
  assert.equal(body.user.email, "review@webnestdev.local");
  assert.equal(body.onboarding.profile.name, "Гость NestDev");
  demoCookie = sessionCookie(first);

  const again = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: demoCookie } });
  assert.equal(again.json().authenticated, true);
  assert.equal(again.json().publicDemo, true);
});

test("?login=1 оставляет обычный вход, даже если демо-cookie уже есть", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  const manual = await app.inject({ method: "GET", url: "/api/auth/me?login=1", headers: { cookie: demoCookie } });
  assert.equal(manual.statusCode, 200);
  assert.equal(manual.json().authenticated, false);

  // Следующий обычный заход снова открывает демо и даёт свежую cookie для проверки выключения.
  const back = await app.inject({ method: "GET", url: "/api/auth/me" });
  assert.equal(back.json().authenticated, true);
  demoCookie = sessionCookie(back);
});

test("реальный пользователь не подменяется демо-аккаунтом", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  const user = await createUser("real-user@example.test", "password-123");
  const session = await createSession(user.id);
  const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: "webnestdev_session=" + session.id } });
  assert.equal(response.json().authenticated, true);
  assert.equal(response.json().user.email, "real-user@example.test");
  assert.equal(response.json().publicDemo, undefined);
});

test("после выключения флага демо-cookie больше не открывает сайт", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  await savePlatformEnv({ WEBNESTDEV_PUBLIC_DEMO: "0" });
  try {
    const response = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: demoCookie } });
    assert.equal(response.json().authenticated, false);
    assert.equal(response.json().publicDemo, false);
  } finally {
    await savePlatformEnv({ WEBNESTDEV_PUBLIC_DEMO: "1" });
  }

  const back = await app.inject({ method: "GET", url: "/api/auth/me" });
  assert.equal(back.json().authenticated, true);
  assert.equal(back.json().publicDemo, true);
});

test.after(async () => {
  delete process.env.WEBNESTDEV_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});
