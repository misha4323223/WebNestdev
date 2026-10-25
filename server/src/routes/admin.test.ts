import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Вход администратора проверяется через настоящий HTTP-слой: хранилище — временный каталог, поэтому
 * тест не трогает данные рабочей области и не требует базы.
 *
 * Переменные окружения выставляются до импорта модулей: тип хранилища и каталог данных читаются при
 * загрузке admin-store, и подменить их после импорта было бы поздно.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-routes-"));

const Fastify = (await import("fastify")).default;
const { registerAdminRoutes } = await import("./admin.js");
const { createAdmin } = await import("../admin/admin-store.js");
const { totp } = await import("../admin/totp.js");
const { clearAuthRateLimits } = await import("../auth/auth-rate-limit.js");

const EMAIL = "admin@example.test";
const PASSWORD = "correct-horse-battery";

const app = Fastify();
await registerAdminRoutes(app);

async function login(password = PASSWORD) {
  const response = await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: EMAIL, password } });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function verify(challenge: string, code: string) {
  const response = await app.inject({ method: "POST", url: "/api/admin/2fa/verify", payload: { challenge, code } });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

let secret = "";
let recoveryCodes: string[] = [];

test("пароль без кода не даёт сессию: первый вход ведёт к подключению TOTP", async () => {
  clearAuthRateLimits();
  await createAdmin(EMAIL, PASSWORD);

  const wrong = await login("wrong-password-1");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "Неверный email или пароль");

  const unknown = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { email: "ghost@example.test", password: PASSWORD },
  });
  // Неизвестный администратор отвечает тем же текстом и тем же кодом, что и неверный пароль.
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(unknown.json(), { error: "Неверный email или пароль" });

  const first = await login();
  assert.equal(first.status, 200);
  assert.equal(first.body.stage, "enroll");
  assert.ok(String(first.body.challenge).length >= 10);

  const setup = await app.inject({
    method: "POST",
    url: "/api/admin/2fa/setup",
    payload: { challenge: first.body.challenge },
  });
  assert.equal(setup.statusCode, 200);
  const setupBody = setup.json() as { challenge: string; secret: string; otpauth: string };
  assert.match(setupBody.secret, /^[A-Z2-7]{32}$/);
  assert.ok(setupBody.otpauth.startsWith("otpauth://totp/"));
  secret = setupBody.secret;

  const enabled = await app.inject({
    method: "POST",
    url: "/api/admin/2fa/enable",
    payload: { challenge: setupBody.challenge, code: totp(secret) },
  });
  assert.equal(enabled.statusCode, 200);
  const body = enabled.json() as { token: string; recoveryCodes: string[]; admin: { totpEnabled: boolean } };
  assert.ok(body.token.length >= 20, "в ответе настоящий токен сессии");
  assert.equal(body.admin.totpEnabled, true);
  assert.equal(body.recoveryCodes.length, 10);
  recoveryCodes = body.recoveryCodes;

  // Токен работает, пока сессия жива; без заголовка админка закрыта.
  const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { authorization: "Bearer " + body.token } });
  assert.equal(me.statusCode, 200);
  assert.equal((me.json() as { admin: { email: string } }).admin.email, EMAIL);

  const anonymous = await app.inject({ method: "GET", url: "/api/admin/me" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(me.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
});

test("повторный вход требует код, и принятый код нельзя предъявить второй раз", async () => {
  clearAuthRateLimits();
  const first = await login();
  assert.equal(first.body.stage, "verify");

  const wrongCode = await verify(String(first.body.challenge), "000000");
  assert.equal(wrongCode.status, 401);
  assert.equal(wrongCode.body.error, "Код не подошёл. Осталось попыток: 4");

  // Следующий шаг — это код «через тридцать секунд»: шаг, использованный при подключении, уже занят.
  const nextCode = totp(secret, Date.now() + 30_000);
  const ok = await verify(String(first.body.challenge), nextCode);
  assert.equal(ok.status, 200);
  assert.ok(String(ok.body.token).length >= 20);
  assert.equal(ok.body.usedRecoveryCode, false);

  // Тот же код во втором входе: шаг уже израсходован.
  const again = await login();
  const replay = await verify(String(again.body.challenge), nextCode);
  assert.equal(replay.status, 401);
  assert.match(String(replay.body.error), /Код не подошёл/);
});

test("код восстановления подходит один раз и уменьшает остаток", async () => {
  clearAuthRateLimits();
  const first = await login();
  const used = await verify(String(first.body.challenge), recoveryCodes[0]);
  assert.equal(used.status, 200);
  assert.equal(used.body.usedRecoveryCode, true);
  assert.equal(used.body.recoveryCodesLeft, 9);

  const second = await login();
  const repeated = await verify(String(second.body.challenge), recoveryCodes[0]);
  assert.equal(repeated.status, 401);
});

test("пять ошибок закрывают шаг входа: дальше нужен пароль заново", async () => {
  clearAuthRateLimits();
  const first = await login();
  const challenge = String(first.body.challenge);
  const expected = [4, 3, 2, 1, 0];
  for (const left of expected) {
    const attempt = await verify(challenge, "000000");
    assert.equal(attempt.status, 401);
    assert.equal(attempt.body.attemptsLeft, left);
  }
  const afterLimit = await verify(challenge, totp(secret, Date.now() + 60_000));
  assert.equal(afterLimit.status, 401);
  assert.equal(afterLimit.body.error, "Шаг входа истёк — начните с пароля");
});

test("новый набор кодов восстановления отменяет старый", async () => {
  clearAuthRateLimits();
  const first = await login();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const entered = await verify(String(first.body.challenge), recoveryCodes[1]);
  assert.equal(entered.status, 200, JSON.stringify(entered.body));

  // Перевыпуск кодов сам требует действующего кода восстановления.
  const rotated = await app.inject({
    method: "POST",
    url: "/api/admin/2fa/recovery",
    headers: { authorization: "Bearer " + entered.body.token },
    payload: { code: recoveryCodes[2] },
  });
  assert.equal(rotated.statusCode, 200, rotated.body);
  const fresh = (rotated.json() as { recoveryCodes: string[] }).recoveryCodes;
  assert.equal(fresh.length, 10);
  recoveryCodes = fresh;

  const next = await login();
  const old = await verify(String(next.body.challenge), "AAAAA-AAAAA");
  assert.equal(old.status, 401, "чужой код не работает");

  const another = await login();
  const current = await verify(String(another.body.challenge), recoveryCodes[0]);
  assert.equal(current.status, 200);
});

test("выход закрывает токен, «выйти везде» — все сессии", async () => {
  clearAuthRateLimits();
  const first = await login();
  const entered = await verify(String(first.body.challenge), recoveryCodes[1]);
  assert.equal(entered.status, 200);
  const token = String(entered.body.token);

  const logout = await app.inject({ method: "POST", url: "/api/admin/logout", headers: { authorization: "Bearer " + token } });
  assert.equal(logout.statusCode, 200);
  const afterLogout = await app.inject({ method: "GET", url: "/api/admin/me", headers: { authorization: "Bearer " + token } });
  assert.equal(afterLogout.statusCode, 401);

  const second = await login();
  const fresh = await verify(String(second.body.challenge), recoveryCodes[2]);
  assert.equal(fresh.status, 200);
  const freshToken = String(fresh.body.token);

  const all = await app.inject({ method: "POST", url: "/api/admin/logout-all", headers: { authorization: "Bearer " + freshToken } });
  assert.equal(all.statusCode, 200);
  // Отзываются все входы администратора, а не только текущий.
  assert.ok((all.json() as { revoked: number }).revoked >= 1);

  const afterAll = await app.inject({ method: "GET", url: "/api/admin/me", headers: { authorization: "Bearer " + freshToken } });
  assert.equal(afterAll.statusCode, 401);
});

test.after(async () => {
  await app.close();
});
