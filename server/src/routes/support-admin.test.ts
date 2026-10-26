import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Внешняя админка уже вошла по паролю и TOTP. Её токен — такая же допустимая дверь к чтению
 * обращений, как отдельный SUPPORT_API_KEY: второй общий секрет в приложении не нужен.
 *
 * Каталог данных выставляется до импорта: admin-store запоминает его при загрузке модуля.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "support-admin-"));

const Fastify = (await import("fastify")).default;
const { registerSupportRoutes } = await import("./support.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const app = Fastify();
await registerSupportRoutes(app);

test("админ-сессия читает обращения, а случайный Bearer — нет", async t => {
  t.after(async () => {
    await app.close();
    await rm(process.env.WEBNESTDEV_DATA_DIR as string, { recursive: true, force: true });
  });

  const admin = await createAdmin("support-admin@example.test", "correct-horse-battery");
  const session = await createAdminSession(admin.id);

  const authorized = await app.inject({
    method: "GET",
    url: "/api/support/tickets?limit=3",
    headers: { authorization: "Bearer " + session.token },
  });
  assert.equal(authorized.statusCode, 200, authorized.body);
  assert.deepEqual(authorized.json(), { tickets: [] });

  const random = await app.inject({
    method: "GET",
    url: "/api/support/tickets",
    headers: { authorization: "Bearer not-a-real-admin-session-token" },
  });
  assert.equal(random.statusCode, 401);
  // Bearer без сессии — это ещё и потенциальный ключ чтения; ключ на сервере не настроен,
  // поэтому заголовок честно говорит «не настроен», а не «нужна сессия».
  assert.equal(random.headers["x-support-auth"], "key-not-configured");
});
