import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Проверка на уровне маршрута: IP — это сеть, а не человек. Четвёртая регистрация с того же
 * адреса должна проходить; ограничивать можно только частоту запросов, а не число аккаунтов.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.NODE_ENV = "test";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "auth-register-ip-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");

async function appWithRoutes() {
  const app = Fastify();
  await app.register(cookie);
  // Письмо подтверждения в тесте не отправляется: регистрация проверяется, а не SMTP.
  await registerAuthRoutes(app, { sendVerificationEmail: async () => ({ ok: true }) });
  await app.ready();
  return app;
}

function register(app: Awaited<ReturnType<typeof appWithRoutes>>, email: string, ip: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/register",
    remoteAddress: ip,
    headers: { "content-type": "application/json" },
    payload: { email, password: "пароль-подлиннее-8" },
  });
}

test("четвёртая регистрация с одного адреса проходит: IP не является личностью", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });
  const ip = "203.0.113.40";

  for (let index = 1; index <= 4; index += 1) {
    const response = await register(app, "user" + index + "@example.com", ip);
    assert.equal(response.statusCode, 201, "регистрация " + index + " должна проходить: " + response.body);
  }
});

test("занятая почта не мешает следующему аккаунту с того же адреса", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });
  const ip = "203.0.113.50";

  assert.equal((await register(app, "taken@example.com", ip)).statusCode, 201);
  const duplicate = await register(app, "taken@example.com", ip);
  assert.equal(duplicate.statusCode, 409);

  const second = await register(app, "another@example.com", ip);
  assert.equal(second.statusCode, 201);
});

test("другой адрес регистрируется независимо", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });

  for (let index = 1; index <= 3; index += 1) {
    assert.equal((await register(app, "blocked" + index + "@example.com", "198.51.100.90")).statusCode, 201);
  }
  const other = await register(app, "other-ip@example.com", "198.51.100.91");
  assert.equal(other.statusCode, 201);
});
