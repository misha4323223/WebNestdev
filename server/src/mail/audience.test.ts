import test from "node:test";
import assert from "node:assert/strict";
import { audienceFor } from "./audience.js";
import { membersOf } from "./segments.js";
import type { MailRosterMember, MailSuppression } from "./types.js";

/**
 * Получатели сегмента. Числа, которые админка показывает в предпросмотре, — это ровно то, что
 * уйдёт в очередь: расчётFiltersом здесь живут отсев служебных адресов, отписок и повторов.
 */

function member(overrides: Partial<MailRosterMember> & { userId: string; email: string }): MailRosterMember {
  return { name: "", loginEmail: overrides.email, plan: "free", lastActiveAt: null, productUpdates: true, ...overrides };
}

const roster: MailRosterMember[] = [
  member({ userId: "u1", email: "ivan@nestdev.ru", name: "Иван", lastActiveAt: "2026-10-26T09:00:00.000Z" }),
  member({ userId: "u2", email: "79531814136@phone.webnestdev.local", lastActiveAt: "2026-10-26T09:00:00.000Z" }),
  member({ userId: "u3", email: "olga@nestdev.ru", plan: "pro", lastActiveAt: "2026-08-01T09:00:00.000Z" }),
  member({ userId: "u4", email: "IVAN@nestdev.ru", lastActiveAt: "2026-10-26T09:00:00.000Z" }),
  member({ userId: "u5", email: "spam@nestdev.ru", lastActiveAt: "2026-10-26T09:00:00.000Z" }),
  member({ userId: "u6", email: "bounce@nestdev.ru", lastActiveAt: null }),
];

const suppressions = new Map<string, MailSuppression>([
  ["spam@nestdev.ru", { email: "spam@nestdev.ru", reason: "complaint", note: "", createdAt: "2026-10-01T00:00:00.000Z" }],
  ["bounce@nestdev.ru", { email: "bounce@nestdev.ru", reason: "bounced", note: "", createdAt: "2026-10-01T00:00:00.000Z" }],
]);

test("сегменты отбираются по входу и тарифу", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  assert.deepEqual(membersOf(roster, "active30", now).map(item => item.userId), ["u1", "u2", "u4", "u5"]);
  assert.deepEqual(membersOf(roster, "inactive30", now).map(item => item.userId), ["u3"]);
  assert.deepEqual(membersOf(roster, "never", now).map(item => item.userId), ["u6"]);
  assert.deepEqual(membersOf(roster, "paying", now).map(item => item.userId), ["u3"]);
  assert.equal(membersOf(roster, "all", now).length, roster.length);
});

test("служебные адреса, отписки и повторы до очереди не доходят", () => {
  const audience = audienceFor("all", roster, suppressions);
  assert.deepEqual(audience.members.map(item => item.email), ["ivan@nestdev.ru", "olga@nestdev.ru"]);
  assert.deepEqual(audience.excluded, { unsubscribed: 0, bounced: 2, invalid: 1, noConsent: 0, duplicate: 1 });
  assert.equal(audience.skipped.length, 4);
  assert.match(audience.skipped[0].reason, /служебный домен/);
});

test("без согласия на рекламные письма адрес в кампанию не попадает", () => {
  const audience = audienceFor(
    "all",
    [member({ userId: "u1", email: "no-consent@nestdev.ru", productUpdates: false })],
    new Map(),
  );
  assert.equal(audience.members.length, 0);
  assert.equal(audience.excluded.noConsent, 1);
  assert.equal(audience.skipped[0].reason, "нет согласия на рекламные письма");
});

test("отписка считается отдельно от отскока", () => {
  const audience = audienceFor(
    "all",
    [member({ userId: "u1", email: "ivan@nestdev.ru" })],
    new Map([["ivan@nestdev.ru", { email: "ivan@nestdev.ru", reason: "unsubscribed" as const, note: "", createdAt: "2026-10-01T00:00:00.000Z" }]]),
  );
  assert.equal(audience.members.length, 0);
  assert.equal(audience.excluded.unsubscribed, 1);
  assert.equal(audience.skipped[0].reason, "отписался от рассылки");
});
