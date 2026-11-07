import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Проверка на уровне маршрута: правило «не больше трёх аккаунтов с адреса» должно отвечать
 * человеку понятным отказом, а не 500, и не должно съедать место на неудачной попытке.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.NODE_ENV = "test";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "auth-register-ip-"));
process.env.WEBNESTDEV_DATA_DIR = root;
delete process.env.SIGNUP_IP_LIMIT;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { signupIpAccounts } = await import("../auth/signup-ip.js");

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

test("четвёртая регистрация с одного адреса получает 403 с объяснением", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });
  const ip = "203.0.113.40";

  for (let index = 1; index <= 3; index += 1) {
    const response = await register(app, "user" + index + "@example.com", ip);
    assert.equal(response.statusCode, 201, "регистрация " + index + " должна проходить: " + response.body);
  }

  const blocked = await register(app, "user4@example.com", ip);
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().code, "SIGNUP_IP_LIMIT");
  assert.match(blocked.json().error, /уже создано 3 аккаунта/);
  assert.match(blocked.json().error, /поддержку/);
  assert.equal(await signupIpAccounts(ip), 3);
});

test("занятая почта не тратит место адреса", async t => {
  const app = await appWithRoutes();
  t.after(async () => { await app.close(); });
  const ip = "203.0.113.50";

  assert.equal((await register(app, "taken@example.com", ip)).statusCode, 201);
  const duplicate = await register(app, "taken@example.com", ip);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(await signupIpAccounts(ip), 1, "отказ по занятой почте не должен считаться аккаунтом");

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
