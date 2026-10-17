import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerPlatformRoutes } from "./platform.js";

/**
 * Маршрут ключей платформы: закрыт администратором, принимает и поля, и целый .env, а в ответе
 * нет ни одного значения секрета — только имена применённых ключей и причина для пропущенных.
 */
async function appWith(isAdmin: boolean) {
  const app = Fastify();
  await registerPlatformRoutes(app, {
    authorize: async () => ({ id: "u1", email: "admin@example.com" }),
    isAdmin: () => isAdmin,
  });
  await app.ready();
  return app;
}

async function withRoot(run: () => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-platform-route-"));
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  try { await run(); }
  finally {
    delete process.env.WEBNESTDEV_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  }
}

test("не админ видит только объяснение, а не список ключей", async () => {
  const app = await appWith(false);
  try {
    const response = await app.inject({ method: "GET", url: "/api/platform/keys" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.admin, false);
    assert.equal(body.keys, undefined);
    assert.match(body.guide, /WEBNESTDEV_ADMIN_EMAILS/);
  } finally { await app.close(); }
});

test("админ сохраняет ключи полями и из .env, а значения не возвращаются в браузер", async () => {
  await withRoot(async () => {
    const app = await appWith(true);
    try {
      const upload = [
        "# GitHub OAuth",
        "GITHUB_CLIENT_ID=Iv1.abcdef",
        'GITHUB_CLIENT_SECRET="client-secret-value"',
        "YANDEX_CLOUD_ID=b1gpj9488h3k7oaa3foh",
        "YANDEX_FOLDER_ID=b1g74qv3u70jmct1ekvf",
        "NODE_ENV=production",
        "RANDOM_THING=1",
      ].join("\r\n");
      const response = await app.inject({ method: "POST", url: "/api/platform/keys", payload: { env: upload } });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(body.saved.sort(), ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "YANDEX_CLOUD_ID", "YANDEX_FOLDER_ID"]);
      assert.deepEqual(body.skipped.map((item: { name: string }) => item.name).sort(), ["NODE_ENV", "RANDOM_THING"]);
      assert.ok(!response.body.includes("client-secret-value"), "секрет не должен вернуться в ответе");

      const fields = await app.inject({ method: "POST", url: "/api/platform/keys", payload: { values: { GITHUB_CLIENT_SECRET: "another-secret-value" } } });
      assert.equal(fields.statusCode, 200);
      assert.deepEqual(fields.json().saved, ["GITHUB_CLIENT_SECRET"]);
      assert.ok(!fields.body.includes("another-secret-value"));

      const status = await app.inject({ method: "GET", url: "/api/platform/keys" });
      const keys = status.json().keys as Array<{ name: string; source: string; value?: string }>;
      const secret = keys.find(entry => entry.name === "GITHUB_CLIENT_SECRET");
      assert.equal(secret?.source, "panel");
      assert.ok(!String(secret?.value).includes("another-secret"));
      assert.equal(keys.find(entry => entry.name === "GITHUB_CLIENT_ID")?.value, "Iv1.abcdef");
    } finally { await app.close(); }
  });
});

test("пустая строка в загруженном .env — шаблон, а не стирание ключа", async () => {
  await withRoot(async () => {
    const app = await appWith(true);
    try {
      await app.inject({ method: "POST", url: "/api/platform/keys", payload: { values: { GITHUB_CLIENT_SECRET: "kept-secret" } } });
      const upload = await app.inject({ method: "POST", url: "/api/platform/keys", payload: { env: "GITHUB_CLIENT_ID=\nGITHUB_CLIENT_SECRET=\nYANDEX_CLOUD_ID=\n" } });
      assert.equal(upload.statusCode, 200);
      assert.deepEqual(upload.json().cleared, []);
      const keys = upload.json().status as Array<{ name: string; source: string }>;
      assert.equal(keys.find(entry => entry.name === "GITHUB_CLIENT_SECRET")?.source, "panel");
    } finally { await app.close(); }
  });
});

test("файл без единого применимого ключа объясняет отказ", async () => {
  await withRoot(async () => {
    const app = await appWith(true);
    try {
      const response = await app.inject({ method: "POST", url: "/api/platform/keys", payload: { env: "NODE_ENV=production\nЯНДЕКС=1" } });
      assert.equal(response.statusCode, 400);
      const body = response.json();
      assert.match(body.error, /NODE_ENV — изменяется при выкладке/);
    } finally { await app.close(); }
  });
});

test("пустой запрос отклоняется, а не стирает все ключи", async () => {
  await withRoot(async () => {
    const app = await appWith(true);
    try {
      const response = await app.inject({ method: "POST", url: "/api/platform/keys", payload: {} });
      assert.equal(response.statusCode, 400);
    } finally { await app.close(); }
  });
});
