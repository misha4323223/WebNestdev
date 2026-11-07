import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Регистрация по почте не должна выдавать сессию до перехода по ссылке. Тесты подменяют
 * отправку письма, поэтому не трогают SMTP и Postbox.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.NODE_ENV = "test";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
process.env.PLATFORM_URL = "https://nestdev.test";
const root = await mkdtemp(path.join(tmpdir(), "auth-email-verification-"));
process.env.WEBNESTDEV_DATA_DIR = root;
// Предел трёх аккаунтов с адреса здесь выключен: этот файл про подтверждение почты, а все
// запросы идут с одного адреса инъекции. Сам предел проверяют auth/signup-ip.test.ts и
// routes/auth-register-ip.test.ts.
process.env.SIGNUP_IP_LIMIT = "0";

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { createUser } = await import("../auth/auth-store.js");
const { clearAuthRateLimits } = await import("../auth/auth-rate-limit.js");

// Счётчики общие: без сброса лимит одного теста блокировал бы следующий.
beforeEach(async () => {
  await clearAuthRateLimits();
});

type Sent = { to: string; link: string };
type Deps = Parameters<typeof registerAuthRoutes>[1];

async function buildApp(sent: Sent[], deps: Deps = {}) {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app, {
    ...deps,
    sendVerificationEmail: async input => {
      sent.push(input);
      return { messageId: "test-mail" };
    },
  });
  await app.ready();
  return app;
}

function cookieFrom(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  assert.equal(typeof value, "string", "issued a session cookie");
  return (value as string).split(";")[0];
}

function tokenFrom(link: string) {
  const token = new URL(link).searchParams.get("verify_email");
  assert.ok(token, "the email contains a verification token");
  return token;
}

test("регистрация создаёт аккаунт без сессии, а подтверждение требует пароль и работает один раз", async t => {
  const sent: Sent[] = [];
  const app = await buildApp(sent);
  t.after(async () => { await app.close(); });

  const email = "verify-" + Date.now() + "@example.test";
  const password = "correct-horse-123";
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    headers: { origin: "https://nestdev.test" },
    payload: { email, password },
  });
  assert.equal(register.statusCode, 201);
  assert.equal(register.json().verificationRequired, true);
  assert.equal(register.json().email, email);
  assert.equal(register.headers["set-cookie"], undefined, "registration alone does not sign in");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, email);
  assert.match(sent[0].link, /^https:\/\/nestdev\.test\/\?verify_email=/);

  const loginBefore = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  assert.equal(loginBefore.statusCode, 403);
  assert.equal(loginBefore.json().code, "EMAIL_NOT_VERIFIED");
  assert.equal(loginBefore.headers["set-cookie"], undefined);

  const token = tokenFrom(sent[0].link);
  // Ссылка только открывает форму: без пароля аккаунт не подтверждается.
  const wrongPassword = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token, password: "wrong-password" },
  });
  assert.equal(wrongPassword.statusCode, 403);
  assert.equal(wrongPassword.json().code, "VERIFICATION_BAD_PASSWORD");
  assert.equal(wrongPassword.headers["set-cookie"], undefined);

  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token, password },
  });
  assert.equal(verify.statusCode, 200);
  const session = cookieFrom(verify);

  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: session },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().authenticated, true);
  assert.equal(me.json().user.email, email);

  const secondOpen = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token, password },
  });
  assert.equal(secondOpen.statusCode, 400);
  assert.equal(secondOpen.json().code, "VERIFICATION_INVALID");
  assert.equal(secondOpen.headers["set-cookie"], undefined);

  const loginAfter = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  assert.equal(loginAfter.statusCode, 200);
  assert.equal(loginAfter.json().user.email, email);
});

test("повторная отправка заменяет ссылку и работает после подтверждения", async t => {
  process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = "0";
  t.after(() => { delete process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS; });
  const sent: Sent[] = [];
  const app = await buildApp(sent);
  t.after(async () => { await app.close(); });

  const email = "resend-" + Date.now() + "@example.test";
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "correct-horse-123" },
  });
  assert.equal(register.statusCode, 201);
  assert.equal(sent.length, 1);

  const resend = await app.inject({
    method: "POST",
    url: "/api/auth/resend-verification",
    payload: { email },
  });
  assert.equal(resend.statusCode, 200);
  assert.equal(resend.json().sent, true);
  assert.equal(sent.length, 2);

  const oldToken = tokenFrom(sent[0].link);
  const newToken = tokenFrom(sent[1].link);
  const oldOpen = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token: oldToken, password: "correct-horse-123" },
  });
  assert.equal(oldOpen.statusCode, 400);
  assert.equal(oldOpen.json().code, "VERIFICATION_INVALID");

  const newOpen = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token: newToken, password: "correct-horse-123" },
  });
  assert.equal(newOpen.statusCode, 200);
  assert.ok(cookieFrom(newOpen));

  // Повторная отправка для уже подтверждённого адреса не создаёт третье письмо.
  const already = await app.inject({
    method: "POST",
    url: "/api/auth/resend-verification",
    payload: { email },
  });
  assert.equal(already.statusCode, 200);
  assert.equal(sent.length, 2);
});

test("неудачная повторная отправка не отбирает старую ссылку", async t => {
  process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = "0";
  t.after(() => { delete process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS; });
  const sent: Sent[] = [];
  let fail = false;
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app, {
    sendVerificationEmail: async input => {
      sent.push(input);
      if (fail) throw new Error("Postbox недоступен");
      return { messageId: "test-mail" };
    },
  });
  await app.ready();
  t.after(async () => { await app.close(); });

  const email = "resend-fail-" + Date.now() + "@example.test";
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "correct-horse-123" },
  });
  assert.equal(register.statusCode, 201);
  assert.equal(sent.length, 1);

  fail = true;
  const resend = await app.inject({
    method: "POST",
    url: "/api/auth/resend-verification",
    payload: { email },
  });
  assert.equal(resend.statusCode, 503);
  assert.equal(resend.json().code, "EMAIL_SEND_FAILED");

  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token: tokenFrom(sent[0].link), password: "correct-horse-123" },
  });
  assert.equal(verify.statusCode, 200);
  assert.ok(cookieFrom(verify));
});

test("истёкшая ссылка не подтверждает аккаунт", async t => {
  const sent: Sent[] = [];
  let clock = Date.now();
  const app = await buildApp(sent, { now: () => clock });
  t.after(async () => { await app.close(); });

  const email = "expired-" + Date.now() + "@example.test";
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "correct-horse-123" },
  });
  assert.equal(register.statusCode, 201);
  clock += 24 * 60 * 60 * 1000 + 1000;

  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-email",
    payload: { token: tokenFrom(sent[0].link), password: "correct-horse-123" },
  });
  assert.equal(verify.statusCode, 410);
  assert.equal(verify.json().code, "VERIFICATION_EXPIRED");
  assert.equal(verify.headers["set-cookie"], undefined);
});

test("сбой отправки не прячет созданный неподтверждённый аккаунт", async t => {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app, {
    sendVerificationEmail: async () => { throw new Error("Postbox недоступен"); },
  });
  await app.ready();
  t.after(async () => { await app.close(); });

  const email = "mail-fail-" + Date.now() + "@example.test";
  const register = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: "correct-horse-123" },
  });
  assert.equal(register.statusCode, 503);
  assert.equal(register.json().code, "EMAIL_SEND_FAILED");
  assert.equal(register.headers["set-cookie"], undefined);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "correct-horse-123" },
  });
  assert.equal(login.statusCode, 403);
  assert.equal(login.json().code, "EMAIL_NOT_VERIFIED");
});

test("аккаунты, созданные до подтверждения почты, по-прежнему входят", async t => {
  const app = await buildApp([]);
  t.after(async () => { await app.close(); });
  const email = "legacy-" + Date.now() + "@example.test";
  await createUser(email, "correct-horse-123");

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "correct-horse-123" },
  });
  assert.equal(login.statusCode, 200);
  assert.ok(cookieFrom(login));
});

test.after(async () => {
  delete process.env.PLATFORM_URL;
  delete process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS;
  await rm(root, { recursive: true, force: true });
});
