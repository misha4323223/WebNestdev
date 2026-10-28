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
const { registerNotificationRoutes } = await import("./notifications.js");
const { registerAuthRoutes } = await import("./auth.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createSession, createUser, getSession } = await import("../auth/auth-store.js");
const { accountPlanFor, getSubscriptionRecord } = await import("../billing/store.js");
const { getTokenBudget } = await import("../account/usage-store.js");
const { getRestriction, blockedMessageFor } = await import("../account/restriction-store.js");
const { clearAuthRateLimits } = await import("../auth/auth-rate-limit.js");
const { listAudit } = await import("../security/audit-journal.js");

const PASSWORD = "user-password-123";
const admin = await createAdmin("actions-admin@example.test", "correct-horse-battery");
const adminSession = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + adminSession.token };

const app = Fastify();
await app.register(cookie);
await registerAdminUserActionRoutes(app);
await registerNotificationRoutes(app);
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
  // Причина, которую указал администратор, доходит до человека — иначе он видит общее «заблокирован».
  assert.equal(login.json().error, blockedMessageFor(restriction));
  assert.match(login.json().error, /спам в поддержку/);

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
  assert.equal(granted.json().planUntil, granted.json().subscription.renewsAt);

  const record = await getSubscriptionRecord(user.id);
  assert.equal(record?.plan, "pro");
  // Автопродление выключено: выданный тариф не должен однажды превратиться в счёт.
  assert.equal(record?.autoRenew, false);
  assert.equal(granted.json().planUntil, record!.renewsAt);
  const daysLeft = (new Date(record!.renewsAt).getTime() - Date.now()) / 86_400_000;
  assert.ok(daysLeft > 55 && daysLeft < 65, "два месяца вперёд, а не 60 дней подряд: " + daysLeft);

  // Передача двух сроков сразу отвергается, а не «пусть будет days».
  const both = await action(user.id, "plan", { confirm: true, plan: "pro", months: 1, days: 1 });
  assert.equal(both.statusCode, 400);

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
  // Баланс в ответе — доступный остаток пула, а не сумма выдачи.
  assert.equal(first.json().tokens, first.json().budget.remaining);
  assert.equal(first.json().tokens, 50_000_000 + 1_000_000);
  assert.match(first.json().message, /1 000 000/);

  const second = await action(user.id, "tokens", { confirm: true, tokens: 2_500_000 });
  assert.equal(second.json().bonus, 3_500_000);
  assert.equal(second.json().tokens, second.json().budget.remaining);
  // Баланс вырос ровно на выданную сумму, а не остался прежним.
  assert.equal(second.json().tokens, first.json().tokens + 2_500_000);

  const budget = await getTokenBudget(user.id, "pro");
  // Пул тарифа не подменяется, а расширяется: 50 млн + надбавка.
  assert.equal(budget.bonus, 3_500_000);
  assert.equal(budget.limit, 50_000_000 + 3_500_000);
  assert.equal(budget.remaining, budget.limit - budget.used);

  const rejected = await action(user.id, "tokens", { confirm: true, tokens: 10 });
  assert.equal(rejected.statusCode, 400);
});

test("уведомление о тарифе доходит только до этого аккаунта и отмечается прочитанным", async () => {
  const user = await makeUser();
  const other = await makeUser();

  const first = await action(user.id, "plan", { confirm: true, plan: "pro", days: 1, notify: true });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().notified, true);
  const firstUntil = new Date(first.json().planUntil).getTime();
  assert.ok(firstUntil > Date.now(), "срок должен быть в будущем");

  // Второй день считается от текущего planUntil, а не от сегодня.
  const second = await action(user.id, "plan", { confirm: true, plan: "pro", days: 1, notify: true });
  assert.equal(second.statusCode, 200);
  const secondUntil = new Date(second.json().planUntil).getTime();
  assert.ok(secondUntil > firstUntil, "второй день должен добавиться к первому");

  const gift = await action(user.id, "tokens", { confirm: true, tokens: 500_000, notify: true });
  assert.equal(gift.json().notified, true);

  const session = await createSession(user.id);
  const cookie = "webnestdev_session=" + session.id;
  const list = await app.inject({ method: "GET", url: "/api/me/notifications", headers: { cookie } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().unread, 3);
  assert.equal(list.json().notifications.length, 3);

  const planNotice = list.json().notifications.find((item: { kind: string; planUntil: string | null }) => item.kind === "plan" && item.planUntil === second.json().planUntil)!;
  assert.ok(planNotice, "уведомление второго продления должно быть в списке");
  assert.equal(planNotice.plan, "pro");
  assert.equal(planNotice.tokens, null);
  assert.equal(planNotice.planUntil, second.json().planUntil);
  assert.match(planNotice.message, /Плюс/);

  const giftNotice = list.json().notifications.find((item: { kind: string }) => item.kind === "gift");
  assert.equal(giftNotice.tokens, 500_000);
  assert.match(giftNotice.message, /500 000/);

  const read = await app.inject({ method: "POST", url: "/api/me/notifications/" + planNotice.id + "/read", headers: { cookie } });
  assert.equal(read.statusCode, 200);
  const after = await app.inject({ method: "GET", url: "/api/me/notifications", headers: { cookie } });
  assert.equal(after.json().unread, 2);

  const stranger = await app.inject({ method: "POST", url: "/api/me/notifications/" + planNotice.id + "/read", headers: { cookie: "webnestdev_session=" + (await createSession(other.id)).id } });
  assert.equal(stranger.statusCode, 404);

  const all = await app.inject({ method: "POST", url: "/api/me/notifications/read-all", headers: { cookie } });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().read, 2);
  const cleared = await app.inject({ method: "GET", url: "/api/me/notifications", headers: { cookie } });
  assert.equal(cleared.json().unread, 0);
});
