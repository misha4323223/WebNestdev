import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerSupportRoutes } from "./support.js";
import { createSession, createUser } from "../auth/auth-store.js";

/**
 * Отдельного ключа чтения обращений больше нет: единственные двери — админ-сессия внешней
 * админки и сессия администратора платформы в браузере. Тест держит каталог обращений пустым,
 * чтобы проверять только авторизацию, а не хранилище.
 */
process.env.WEBNESTDEV_STORAGE = "json";

async function appWith() {
  const previousDir = process.env.WEBNESTDEV_DATA_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "support-api-"));
  process.env.WEBNESTDEV_DATA_DIR = dir;
  const app = Fastify();
  await app.register(cookie);
  await registerSupportRoutes(app);
  await app.ready();
  return {
    app,
    async close() {
      await app.close();
      if (previousDir === undefined) delete process.env.WEBNESTDEV_DATA_DIR;
      else process.env.WEBNESTDEV_DATA_DIR = previousDir;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("без админ-сессии чтение и скриншоты закрыты", async () => {
  const { app, close } = await appWith();
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/support/tickets" });
    assert.equal(anonymous.statusCode, 401);

    const randomBearer = await app.inject({
      method: "GET",
      url: "/api/support/tickets",
      headers: { authorization: "Bearer not-a-real-admin-session-token" },
    });
    assert.equal(randomBearer.statusCode, 401);

    const screenshot = await app.inject({
      method: "GET",
      url: "/api/support/tickets/6f1f0b5e-0000-4000-8000-000000000000/screenshot",
    });
    assert.equal(screenshot.statusCode, 401);
  } finally {
    await close();
  }
});

test("обычный пользователь не читает чужие обращения", async () => {
  const { app, close } = await appWith();
  try {
    const user = await createUser("reader-" + Date.now() + "@example.test", "correct-horse-battery");
    const session = await createSession(user.id);
    const response = await app.inject({
      method: "GET",
      url: "/api/support/tickets",
      headers: { cookie: "webnestdev_session=" + session.id },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /администратору платформы/);
  } finally {
    await close();
  }
});

test("чужой Bearer не создаёт обращение: создание остаётся за пользовательской сессией", async () => {
  const { app, close } = await appWith();
  try {
    const create = await app.inject({
      method: "POST",
      url: "/api/support",
      headers: { authorization: "Bearer not-a-real-admin-session-token", "content-type": "application/json" },
      payload: { category: "bug", severity: 3, description: "Описание проблемы", screenshot: "data:image/png;base64," + "A".repeat(120) },
    });
    assert.equal(create.statusCode, 401);
  } finally {
    await close();
  }
});
