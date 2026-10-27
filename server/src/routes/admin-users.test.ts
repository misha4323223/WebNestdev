import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Действия администратора над аккаунтом проверяются на живом маршруте, а не на отдельных
 * функциях: главное здесь — что действие действительно меняет доступ. Поэтому тест входит
 * пользователем по паролю и смотрит, что после блокировки вход отвечает 403, а выданная ранее
 * сессия перестаёт открывать `/api/auth/me`.
 *
 * Окружение выставляется до импорта: auth-store читает тип хранилища и каталог данных при загрузке.
 */
process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-users-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAdminUserActionRoutes } = await import("./admin-users.js");
const { registerAuthRoutes } = await import("./auth.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createSession, createUser, getSession } = await import("../auth/auth-store.js");
const { accountPlanFor, getSubscriptionRecord } = await import("../billing/store.js");
const { getTokenBudget } = await import("../account/usage-store.js");
const { getRestriction, ACCOUNT_BLOCKED_MESSAGE } = await import("../account/restriction-store.js");
const { clearAuthRateLimits } = await import("../auth/auth-rate-limit.js");
const { listAudit } = await import("../security/audit-journal.js");

const PASSWORD = "user-password-123";
const admin = await createAdmin("actions-admin@example.test", "correct-horse-battery");
const adminSession = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + adminSession.token };

const app = Fastify();
await app.register(cookie);
await registerAdminUserActionRoutes(app);
await registerAuthRoutes(app);
await app.ready();

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
async function makeUser() {
  counter += 1;
  return createUser("actions-" + counter + "@example.test", PASSWORD);
}

const action = async (id: string, name: string, body: Record<string, unknown>) =>
  await app.inject({ method: "POST", url: "/api/admin/users/" + id + "/" + name, headers: auth, payload: body });

test("маршруты требуют админ-сессию и подтверждение", async () => {
  const user = await makeUser();

  const anonymous = await app.inject({ method: "POST", url: "/api/admin/users/" + user.id + "/sessions/revoke", payload: { confirm: true } });
  assert.equal(anonymous.statusCode, 401);

  const noConfirm = await action(user.id, "sessions/revoke", {});
  assert.equal(noConfirm.statusCode, 400);

  // Лишнее поле — это отказ, а не «сделаем что просили и заодно это»: маршрут не умеет
  // удалять контейнеры и не должен принимать похожий на это запрос.
  const extra = await action(user.id, "sessions/revoke", { confirm: true, scope: "volumes" });
  assert.equal(extra.statusCode, 400);

  const missing = await action("no-such-user", "sessions/revoke", { confirm: true });
  assert.equal(missing.statusCode, 404);
});

test("отзыв сеансов действительно закрывает все входы аккаунта", async () => {
  const user = await makeUser();
  const first = await createSession(user.id);
  const second = await createSession(user.id);

  const revoked = await action(user.id, "sessions/revoke", { confirm: true });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().revoked, 2);
  assert.equal(await getSession(first.id), null);
  assert.equal(await getSession(second.id), null);

  const audit = await listAudit({ action: "user.sessions.revoked.admin", limit: 5 });
  assert.equal(audit[0]?.target, user.id);
  assert.equal(audit[0]?.actorId, admin.id);
});

test("блокировка закрывает вход, уже выданную сессию и снимается обратно", async () => {
  clearAuthRateLimits();
  const user = await makeUser();
  const session = await createSession(user.id);

  const blocked = await action(user.id, "block", { confirm: true, reason: "спам в поддержку" });
  assert.equal(blocked.statusCode, 200);
  assert.equal(blocked.json().blocked.reason, "спам в поддержку");
  // Сеансы отзываются тем же действием: иначе блокировка оставляла бы открытую вкладку.
  assert.equal(blocked.json().revoked, 1);
  assert.equal(await getSession(session.id), null);

  const restriction = await getRestriction(user.id);
  assert.equal(restriction?.blockedBy, admin.id);

  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: "webnestdev_session=" + session.id } });
  assert.equal(me.json().authenticated, false);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 403);
  assert.equal(login.json().error, ACCOUNT_BLOCKED_MESSAGE);

  // Свой аккаунт заблокировать нельзя — проверка стоит до чтения цели.
  const self = await action(admin.id, "block", { confirm: true });
  assert.equal(self.statusCode, 400);

  const state = await app.inject({ method: "GET", url: "/api/admin/users/" + user.id + "/restriction", headers: auth });
  assert.equal(state.json().blocked, true);

  const unblocked = await action(user.id, "unblock", { confirm: true });
  assert.equal(unblocked.statusCode, 200);
  assert.equal(unblocked.json().wasBlocked, true);
  assert.equal(await getRestriction(user.id), null);

  const again = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password: PASSWORD },
  });
  assert.equal(again.statusCode, 200);

  const audit = await listAudit({ action: "user.blocked", limit: 5 });
  assert.equal(audit[0]?.target, user.id);
});

test("тариф выдаётся без оплаты и без автопродления, снять его тоже можно", async () => {
  const user = await makeUser();
  assert.equal(await accountPlanFor(user.id), "free");

  const granted = await action(user.id, "plan", { confirm: true, plan: "pro", months: 2 });
  assert.equal(granted.statusCode, 200);
  assert.equal(granted.json().plan, "pro");

  const record = await getSubscriptionRecord(user.id);
  assert.equal(record?.plan, "pro");
  // Автопродление выключено: выданный тариф не должен однажды превратиться в счёт.
  assert.equal(record?.autoRenew, false);
  const daysLeft = (new Date(record!.renewsAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(daysLeft > 55 && daysLeft < 65, "два месяца вперёд, а не 60 дней подряд: " + daysLeft);

  const downgraded = await action(user.id, "plan", { confirm: true, plan: "free" });
  assert.equal(downgraded.statusCode, 200);
  assert.equal(await accountPlanFor(user.id), "free");

  // Снимать больше нечего — это 409, а не «успешно» и не ошибка запроса.
  const nothing = await action(user.id, "plan", { confirm: true, plan: "free" });
  assert.equal(nothing.statusCode, 409);

  const badPlan = await action(user.id, "plan", { confirm: true, plan: "enterprise" });
  assert.equal(badPlan.statusCode, 400);
});

test("токены складываются и расширяют пул текущего месяца", async () => {
  const user = await makeUser();
  await action(user.id, "plan", { confirm: true, plan: "pro" });

  const first = await action(user.id, "tokens", { confirm: true, tokens: 1_000_000 });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().bonus, 1_000_000);

  const second = await action(user.id, "tokens", { confirm: true, tokens: 2_500_000 });
  assert.equal(second.json().bonus, 3_500_000);

  const budget = await getTokenBudget(user.id, "pro");
  // Пул тарифа не подменяется, а расширяется: 50 млн + надбавка.
  assert.equal(budget.bonus, 3_500_000);
  assert.equal(budget.limit, 50_000_000 + 3_500_000);
  assert.equal(budget.remaining, budget.limit - budget.used);

  const rejected = await action(user.id, "tokens", { confirm: true, tokens: 10 });
  assert.equal(rejected.statusCode, 400);
});
