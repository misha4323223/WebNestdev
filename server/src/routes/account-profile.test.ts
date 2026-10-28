import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Контакты знакомства проверяются через настоящий HTTP-слой: почта необязательна, а согласие и
 * источник меняются по одному полю. Сессия ставится cookie — так же, как её ставит вход в панель.
 *
 * Переменные выставляются до импорта: хранилище и каталог данных читаются при загрузке модулей.
 */
const dir = await mkdtemp(path.join(tmpdir(), "account-profile-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = dir;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { ZodError } = await import("zod");
const { registerAccountRoutes } = await import("./account.js");
const { createUser, createSession } = await import("../auth/auth-store.js");

const app = Fastify();
// Та же обработка ошибок, что в index.ts: без неё проверка тела отвечала бы 500.
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) return reply.code(400).send({ error: "Некорректный запрос" });
  return reply.code(500).send({ error: "Внутренняя ошибка сервера" });
});
await app.register(cookie);
await registerAccountRoutes(app);

const user = await createUser("client@nestdev.ru", "client-password");
const session = await createSession(user.id);
const headers = { cookie: "webnestdev_session=" + session.id };

function request(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as never }) });
}

test("почту в знакомстве можно не оставлять", async () => {
  const response = await request("POST", "/api/account/onboarding", { name: "Иван" });
  assert.equal(response.statusCode, 200, response.body);
  const profile = (response.json() as { profile: { email: string; source: string; productUpdates: boolean } }).profile;
  assert.equal(profile.email, "");
  assert.equal(profile.source, "");
  assert.equal(profile.productUpdates, false);
});

test("источник и согласие сохраняются точечно, некорректная почта отклоняется", async () => {
  const source = await request("PATCH", "/api/account/profile", { source: "ВКонтакте" });
  assert.equal(source.statusCode, 200, source.body);
  assert.equal((source.json() as { profile: { source: string } }).profile.source, "ВКонтакте");

  const consent = await request("PATCH", "/api/account/profile", { productUpdates: true });
  assert.equal(consent.statusCode, 200, consent.body);
  const profile = (consent.json() as { profile: { productUpdates: boolean; source: string } }).profile;
  assert.equal(profile.productUpdates, true);
  assert.equal(profile.source, "ВКонтакте", "правка одного поля не стирает другое");

  const bad = await request("PATCH", "/api/account/profile", { email: "не-почта" });
  assert.equal(bad.statusCode, 400);

  const empty = await request("PATCH", "/api/account/profile", {});
  assert.equal(empty.statusCode, 400);

  const contact = await request("GET", "/api/account/contact");
  assert.equal(contact.statusCode, 200);
  assert.deepEqual(contact.json(), { email: "", loginEmail: "client@nestdev.ru" });
});

test.after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});
