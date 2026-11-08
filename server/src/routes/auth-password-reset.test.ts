import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Восстановление пароля: письмо, одноразовая ссылка, отзыв старых сессий и запрет
 * отправлять письма на служебные адреса (телефон, Яндекс ID, VK ID).
 *
 * Отправка письма подменяется, поэтому тест не трогает SMTP и Postbox.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.NODE_ENV = "test";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
process.env.PLATFORM_URL = "https://nestdev.test";
process.env.SIGNUP_IP_LIMIT = "0";
const root = await mkdtemp(path.join(tmpdir(), "auth-password-reset-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { createUser, createSession } = await import("../auth/auth-store.js");
const { clearAuthRateLimits } = await import("../auth/auth-rate-limit.js");

beforeEach(async () => {
  await clearAuthRateLimits();
});

type Sent = { to: string; link: string };

async function buildApp(sent: Sent[], deps: Parameters<typeof registerAuthRoutes>[1] = {}) {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app, {
    ...deps,
    sendVerificationEmail: async () => ({ messageId: "verification-mail" }),
    sendPasswordResetEmail: async input => {
      sent.push(input);
      return { messageId: "reset-mail" };
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
  const token = new URL(link).searchParams.get("reset_password");
  assert.ok(token, "the email contains a reset token");
  return token;
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
}

test("письмо уходит только на настоящий адрес, а ответ одинаковый", async t => {
  const sent: Sent[] = [];
  const app = await buildApp(sent);
  t.after(async () => { await app.close(); });

  const unknown = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/request",
    payload: { email: "nobody-" + Date.now() + "@example.test" },
  });
  assert.equal(unknown.statusCode, 200);
  assert.deepEqual(unknown.json(), { sent: true });
  assert.equal(sent.length, 0, "unknown address gets no letter");

  const email = "reset-" + Date.now() + "@example.test";
  await createUser(email, "old-password-123");
  const known = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/request",
    payload: { email },
  });
  assert.equal(known.statusCode, 200);
  // Ответ не должен отличаться от ответа для чужого адреса — иначе это проверка аккаунта.
  assert.deepEqual(known.json(), { sent: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, email);
  assert.match(sent[0].link, /^https:\/\/nestdev\.test\/\?reset_password=/);

  // Служебные адреса писем не получают: пароля у таких аккаунтов нет.
  const phoneEmail = "79530000001@phone.webnestdev.local";
  await createUser(phoneEmail, "random-nobody-knows");
  const phone = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/request",
    payload: { email: phoneEmail },
  });
  assert.equal(phone.statusCode, 200);
  assert.deepEqual(phone.json(), { sent: true });
  assert.equal(sent.length, 1);
});

test("ссылка меняет пароль один раз и отзывает старые сессии", async t => {
  const sent: Sent[] = [];
  const app = await buildApp(sent);
  t.after(async () => { await app.close(); });

  const email = "reset-once-" + Date.now() + "@example.test";
  const oldPassword = "old-password-123";
  const newPassword = "new-password-456";
  await createUser(email, oldPassword);

  const before = await login(app, email, oldPassword);
  assert.equal(before.statusCode, 200);
  const oldSession = cookieFrom(before);

  const request = await app.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email } });
  assert.equal(request.statusCode, 200);
  assert.equal(sent.length, 1);

  const token = tokenFrom(sent[0].link);
  const confirm = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/confirm",
    payload: { token, password: newPassword },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const freshSession = cookieFrom(confirm);

  // Новая cookie открывает аккаунт, старая — уже нет.
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: freshSession } });
  assert.equal(me.json().authenticated, true);
  assert.equal(me.json().user.email, email);
  assert.equal(me.json().user.hasPassword, true);
  const oldMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: oldSession } });
  assert.equal(oldMe.json().authenticated, false);

  // Старый пароль больше не подходит, новый — подходит.
  assert.equal((await login(app, email, oldPassword)).statusCode, 401);
  assert.equal((await login(app, email, newPassword)).statusCode, 200);

  // Повторный переход по той же ссылке пароль не меняет.
  const again = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/confirm",
    payload: { token, password: "another-password-789" },
  });
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().code, "PASSWORD_RESET_INVALID");
  assert.equal((await login(app, email, newPassword)).statusCode, 200);
});

test("сброс подтверждает почту: неподтверждённый аккаунт после него входит", async t => {
  const sent: Sent[] = [];
  const app = await buildApp(sent);
  t.after(async () => { await app.close(); });

  const email = "reset-unverified-" + Date.now() + "@example.test";
  await createUser(email, "old-password-123", { emailVerified: false });
  assert.equal((await login(app, email, "old-password-123")).json().code, "EMAIL_NOT_VERIFIED");

  await app.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email } });
  const confirm = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/confirm",
    payload: { token: tokenFrom(sent[0].link), password: "new-password-456" },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal((await login(app, email, "new-password-456")).statusCode, 200);
});

test("истёкшая ссылка отвечает 410 и пароль не меняет", async t => {
  const sent: Sent[] = [];
  let clock = Date.now();
  const app = await buildApp(sent, { now: () => clock });
  t.after(async () => { await app.close(); });

  const email = "reset-expired-" + Date.now() + "@example.test";
  await createUser(email, "old-password-123");
  await app.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email } });

  clock += 60 * 60 * 1000 + 1000;
  const confirm = await app.inject({
    method: "POST",
    url: "/api/auth/password-reset/confirm",
    payload: { token: tokenFrom(sent[0].link), password: "new-password-456" },
  });
  assert.equal(confirm.statusCode, 410);
  assert.equal(confirm.json().code, "PASSWORD_RESET_EXPIRED");
  assert.equal((await login(app, email, "old-password-123")).statusCode, 200);
});

test("смена пароля требует текущий и завершает остальные сессии", async t => {
  const app = await buildApp([]);
  t.after(async () => { await app.close(); });

  const email = "change-" + Date.now() + "@example.test";
  const password = "current-password-1";
  await createUser(email, password);

  const first = await login(app, email, password);
  const second = await login(app, email, password);
  const firstSession = cookieFrom(first);
  const secondSession = cookieFrom(second);

  const wrong = await app.inject({
    method: "POST",
    url: "/api/auth/password/change",
    headers: { cookie: firstSession },
    payload: { currentPassword: "not-the-password", newPassword: "next-password-2" },
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().code, "PASSWORD_MISMATCH");

  const same = await app.inject({
    method: "POST",
    url: "/api/auth/password/change",
    headers: { cookie: firstSession },
    payload: { currentPassword: password, newPassword: password },
  });
  assert.equal(same.statusCode, 400);
  assert.equal(same.json().code, "PASSWORD_SAME");

  const changed = await app.inject({
    method: "POST",
    url: "/api/auth/password/change",
    headers: { cookie: firstSession },
    payload: { currentPassword: password, newPassword: "next-password-2" },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().ok, true);
  const currentSession = cookieFrom(changed);

  // Вкладка, с которой меняли пароль, остаётся; вторая сессия отозвана.
  const currentMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: currentSession } });
  assert.equal(currentMe.json().authenticated, true);
  const secondMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: secondSession } });
  assert.equal(secondMe.json().authenticated, false);

  assert.equal((await login(app, email, password)).statusCode, 401);
  assert.equal((await login(app, email, "next-password-2")).statusCode, 200);
});

test("у аккаунта без пароля смена отвечает PASSWORD_NOT_SET", async t => {
  const app = await buildApp([]);
  t.after(async () => { await app.close(); });

  const email = "79530000002@phone.webnestdev.local";
  const user = await createUser(email, "random-nobody-knows");
  const session = await createSession(user.id);

  const changed = await app.inject({
    method: "POST",
    url: "/api/auth/password/change",
    headers: { cookie: "webnestdev_session=" + session.id },
    payload: { currentPassword: "random-nobody-knows", newPassword: "next-password-2" },
  });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().code, "PASSWORD_NOT_SET");
});

test("сбой почты не выдаёт, существует ли адрес, и не ломает запрос", async t => {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app, {
    sendPasswordResetEmail: async () => { throw new Error("Postbox недоступен"); },
  });
  await app.ready();
  t.after(async () => { await app.close(); });

  const email = "reset-mail-fail-" + Date.now() + "@example.test";
  await createUser(email, "old-password-123");
  const request = await app.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email } });
  assert.equal(request.statusCode, 200);
  assert.deepEqual(request.json(), { sent: true });
});

test.after(async () => {
  delete process.env.PLATFORM_URL;
  await rm(root, { recursive: true, force: true });
});
