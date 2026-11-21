import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Каталог данных читается при импорте модуля, поэтому тест задаёт его до импорта,
// а хранилище — явно json, чтобы тест не зависел от NODE_ENV.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "webnestdev-auth-"));
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = root;

const {
  createSession,
  deleteUserSessions,
  getSession,
  getUserLastSeenAt,
  migrateLegacySessions,
  sessionIdleTtlMs,
  sessionTokenHash,
  sessionTtlMs,
} = await import("./auth-store.js");

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const day = 24 * 60 * 60 * 1000;
const sessionsFile = () => path.join(root, "auth", "sessions.json");
type StoredSession = { id: string; userId: string; expiresAt: string; lastSeenAt?: string };
const readSessions = () => JSON.parse(fs.readFileSync(sessionsFile(), "utf8")) as StoredSession[];
/** Запись в том виде, в каком её сохранило хранилище: id — хеш токена из cookie. */
const storedSession = (token: string) => readSessions().find(item => item.id === sessionTokenHash(token));

test("политика: неделя бездействия, месяц всего, бездействие не длиннее срока", () => {
  assert.equal(sessionIdleTtlMs(), 7 * day);
  assert.equal(sessionTtlMs(), 30 * day);
  assert.ok(sessionTtlMs() > sessionIdleTtlMs());
});

test("новая сессия хранится хешем, а cookie получает исходный токен", async () => {
  const session = await createSession("user-hash");
  assert.ok(session.id);
  assert.equal(readSessions().some(item => item.id === session.id), false, "raw-токен не должен попадать в базу");
  assert.ok(storedSession(session.id), "в базе должен лежать sha256 от токена");
  assert.equal((await getSession(session.id))?.id, session.id);
});

test("хеш из базы нельзя использовать как cookie", async () => {
  const session = await createSession("user-hash-replay");
  const stored = readSessions().find(item => item.id === sessionTokenHash(session.id));
  assert.ok(stored);
  assert.equal(await getSession(stored.id), null);
});

test("стартовая миграция переводит все старые raw-сессии на хеш", async () => {
  const token = "a".repeat(64);
  fs.writeFileSync(sessionsFile(), JSON.stringify([{
    id: token,
    userId: "user-startup-migration",
    expiresAt: new Date(Date.now() + day).toISOString(),
  }]));

  assert.equal(await migrateLegacySessions(), 1);
  assert.equal(readSessions()[0]?.id, sessionTokenHash(token));
  assert.equal((await getSession(token))?.userId, "user-startup-migration");
});

test("старая запись без lastSeenAt не выкидывает пользователя и получает отметку", async () => {
  const now = Date.now();
  const session = await createSession("user-legacy", now);
  // Так выглядела сессия до появления idle-таймаута: только id, userId и expiresAt.
  fs.writeFileSync(sessionsFile(), JSON.stringify([{ id: session.id, userId: session.userId, expiresAt: session.expiresAt }]));

  const restored = await getSession(session.id, now + day);
  assert.equal(restored?.id, session.id);

  assert.equal(storedSession(session.id)?.lastSeenAt, new Date(now + day).toISOString());
});

test("отметка активности пишется раз в минуту, а не на каждый запрос", async () => {
  const now = Date.now();
  const session = await createSession("user-touch", now);
  assert.equal(storedSession(session.id)?.lastSeenAt, new Date(now).toISOString());

  // Через 61 секунду отметка обновляется...
  await getSession(session.id, now + 61_000);
  assert.equal(storedSession(session.id)?.lastSeenAt, new Date(now + 61_000).toISOString());

  // ...а следующий запрос через секунду — уже нет.
  await getSession(session.id, now + 62_000);
  assert.equal(storedSession(session.id)?.lastSeenAt, new Date(now + 61_000).toISOString());
});

test("неделя бездействия делает сессию недействительной и удаляет запись", async () => {
  const now = Date.now();
  const session = await createSession("user-idle", now);
  // Активность была ровно перед границей, но сам запрос приходит через восемь дней.
  assert.equal(await getSession(session.id, now + 8 * day), null);
  assert.equal(storedSession(session.id), undefined);
});

test("сессия старше месяца недействительна, даже если ею пользовались", async () => {
  const now = Date.now();
  const session = await createSession("user-old", now);
  await getSession(session.id, now + 29 * day);
  assert.equal(await getSession(session.id, now + 31 * day), null);
  assert.equal(storedSession(session.id), undefined);
});

test("последняя активность берётся по самой свежей сессии аккаунта", async () => {
  const older = await createSession("user-seen", Date.now() - day);
  const newer = await createSession("user-seen", Date.now());
  const other = await createSession("user-other-seen");

  assert.equal(await getUserLastSeenAt("user-seen"), newer.lastSeenAt);
  assert.notEqual(await getUserLastSeenAt("user-seen"), older.lastSeenAt);
  assert.equal(await getUserLastSeenAt("user-other-seen"), other.lastSeenAt);
  assert.equal(await getUserLastSeenAt("user-without-sessions"), null);
});

test("deleteUserSessions отзывает все сессии пользователя и только их", async () => {
  const first = await createSession("user-all");
  const second = await createSession("user-all");
  const other = await createSession("user-other");

  assert.equal(await deleteUserSessions("user-all"), 2);
  assert.equal(await getSession(first.id), null);
  assert.equal(await getSession(second.id), null);
  assert.equal((await getSession(other.id))?.id, other.id);
  assert.equal(await deleteUserSessions("user-all"), 0);
});
