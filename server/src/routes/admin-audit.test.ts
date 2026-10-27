import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Экран «Безопасность» в админке: события входа, второго фактора и ключей читаются по админ-токену.
 * Хранилище — временный каталог, поэтому тест не требует базы и не трогает рабочую область.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "admin-audit-routes-"));

const Fastify = (await import("fastify")).default;
const { registerAdminRoutes } = await import("./admin.js");
const { registerAdminAuditRoutes } = await import("./admin-audit.js");
const { NO_STORE_HEADERS } = await import("./cache-headers.js");
const { createAdmin } = await import("../admin/admin-store.js");
const { totp } = await import("../admin/totp.js");
const { clearAuthRateLimits } = await import("../auth/auth-rate-limit.js");

const EMAIL = "audit-admin@example.test";
const PASSWORD = "correct-horse-battery";

const app = Fastify();
await registerAdminRoutes(app);
await registerAdminAuditRoutes(app);

async function login(password = PASSWORD) {
  const response = await app.inject({ method: "POST", url: "/api/admin/login", payload: { email: EMAIL, password } });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function read(token: string, query = "") {
  return app.inject({ method: "GET", url: "/api/admin/audit" + query, headers: { authorization: "Bearer " + token } });
}

let token = "";
let secret = "";

test("журнал закрыт без админ-токена", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/audit" });
  assert.equal(response.statusCode, 401);
});

test("вход и подключение второго фактора попадают в журнал", async () => {
  clearAuthRateLimits();
  await createAdmin(EMAIL, PASSWORD);

  const failed = await login("wrong-password");
  assert.equal(failed.status, 401);

  const first = await login();
  assert.equal(first.body.stage, "enroll");

  const setup = await app.inject({
    method: "POST",
    url: "/api/admin/2fa/setup",
    payload: { challenge: first.body.challenge },
  });
  const setupBody = setup.json() as { challenge: string; secret: string };
  secret = setupBody.secret;

  const enabled = await app.inject({
    method: "POST",
    url: "/api/admin/2fa/enable",
    payload: { challenge: setupBody.challenge, code: totp(secret) },
  });
  assert.equal(enabled.statusCode, 200);
  token = String((enabled.json() as { token: string }).token);
});

test("админ читает события, действия каталога и фильтрует по имени", async () => {
  const response = await read(token);
  assert.equal(response.statusCode, 200);
  // Заголовок ставит общий слой API (routes/cache-headers.ts), а не сам маршрут: проверяем, что
  // журнал не переопределяет правило и посредник не сможет отдать старую копию списка событий.
  assert.equal(response.headers["cache-control"], NO_STORE_HEADERS["cache-control"]);
  const body = response.json() as {
    entries: Array<{ action: string; actorLabel: string; details: Record<string, unknown> }>;
    total: number;
    actions: Array<{ action: string; label: string }>;
  };

  const actions = body.entries.map(entry => entry.action);
  assert.ok(actions.includes("admin.login.failed"));
  assert.ok(actions.includes("admin.login.password"));
  assert.ok(actions.includes("admin.2fa.enabled"));
  assert.ok(body.actions.some(item => item.action === "project.deleted" && item.label.includes("проект")));

  // Пароля, TOTP-секрета и кодов восстановления в ответе быть не должно.
  const raw = response.payload;
  assert.doesNotMatch(raw, new RegExp(secret));
  assert.doesNotMatch(raw, new RegExp(PASSWORD));
  assert.doesNotMatch(raw, /recoveryCodes/);

  const filtered = await read(token, "?action=admin.2fa.enabled");
  const filteredBody = filtered.json() as { entries: Array<{ action: string }> };
  assert.deepEqual(filteredBody.entries.map(entry => entry.action), ["admin.2fa.enabled"]);
});

test("неизвестное действие отклоняется, а не отдаёт пустой список", async () => {
  const response = await read(token, "?action=admin.unknown");
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error: string; actions: string[] };
  assert.match(body.error, /Неизвестное действие/);
  assert.ok(body.actions.includes("admin.login.success"));
});

test("попытки сверх лимита тоже видны в журнале", async () => {
  clearAuthRateLimits();
  for (let attempt = 0; attempt < 12; attempt += 1) await login("wrong-password-again");
  const response = await read(token, "?action=admin.login.failed&limit=50");
  const body = response.json() as { entries: Array<{ details: { reason?: string } }> };
  assert.ok(body.entries.some(entry => entry.details.reason === "rate_limited"));
});
