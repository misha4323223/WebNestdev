import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerSupportRoutes } from "./support.js";
import { SUPPORT_API_KEY_ENV } from "../support/support-api-key.js";

const KEY = "read-only-key-0123456789";

/**
 * Внешняя админка не имеет cookie сессии панели: единственная дверь для неё — ключ. Тест держит
 * каталог обращений пустым, чтобы проверять только авторизацию, а не хранилище.
 */
async function appWith(env: { key?: string }) {
  const previousDir = process.env.WEBNESTDEV_DATA_DIR;
  const previousKey = process.env[SUPPORT_API_KEY_ENV];
  const dir = await mkdtemp(path.join(tmpdir(), "support-api-"));
  process.env.WEBNESTDEV_DATA_DIR = dir;
  if (env.key === undefined) delete process.env[SUPPORT_API_KEY_ENV];
  else process.env[SUPPORT_API_KEY_ENV] = env.key;
  const app = Fastify();
  await registerSupportRoutes(app);
  await app.ready();
  return {
    app,
    async close() {
      await app.close();
      if (previousDir === undefined) delete process.env.WEBNESTDEV_DATA_DIR;
      else process.env.WEBNESTDEV_DATA_DIR = previousDir;
      if (previousKey === undefined) delete process.env[SUPPORT_API_KEY_ENV];
      else process.env[SUPPORT_API_KEY_ENV] = previousKey;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the read api answers the external admin app by key, without a panel session", async () => {
  const { app, close } = await appWith({ key: KEY });
  try {
    const bearer = await app.inject({ method: "GET", url: "/api/support/tickets", headers: { authorization: "Bearer " + KEY } });
    assert.equal(bearer.statusCode, 200);
    assert.deepEqual(bearer.json(), { tickets: [] });

    const header = await app.inject({ method: "GET", url: "/api/support/tickets?limit=10", headers: { "x-support-key": KEY } });
    assert.equal(header.statusCode, 200);
  } finally {
    await close();
  }
});

test("without a key or a session the read api stays closed", async () => {
  const { app, close } = await appWith({ key: KEY });
  try {
    const anonymous = await app.inject({ method: "GET", url: "/api/support/tickets" });
    assert.equal(anonymous.statusCode, 401);

    const wrong = await app.inject({ method: "GET", url: "/api/support/tickets", headers: { authorization: "Bearer " + KEY + "-nope" } });
    assert.equal(wrong.statusCode, 401);
  } finally {
    await close();
  }
});

test("the key opens screenshots but is not a licence to create tickets", async () => {
  const { app, close } = await appWith({ key: KEY });
  try {
    // Авторизация ключом прошла, тикета нет — значит 404, а не 401/403.
    const screenshot = await app.inject({
      method: "GET",
      url: "/api/support/tickets/6f1f0b5e-0000-4000-8000-000000000000/screenshot",
      headers: { authorization: "Bearer " + KEY },
    });
    assert.equal(screenshot.statusCode, 404);

    // Отправка обращения — только от имени вошедшего пользователя: ключ читает, но не пишет.
    const create = await app.inject({
      method: "POST",
      url: "/api/support",
      headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
      payload: { category: "bug", severity: 3, description: "Описание проблемы", screenshot: "data:image/png;base64," + "A".repeat(120) },
    });
    assert.equal(create.statusCode, 401);
  } finally {
    await close();
  }
});

test("a key configured too short never opens the api", async () => {
  const { app, close } = await appWith({ key: KEY.slice(0, 15) });
  try {
    const response = await app.inject({ method: "GET", url: "/api/support/tickets", headers: { "x-support-key": KEY.slice(0, 15) } });
    assert.equal(response.statusCode, 401);
  } finally {
    await close();
  }
});
