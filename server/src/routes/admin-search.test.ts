import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Веб-поиск настраивается из внешней админки: провайдер, ключ Yandex с каталогом и резервный
 * ключ Tavily. Проверяем, что ответ не раскрывает секреты, а сохранённый провайдер действительно
 * участвует в выборе цепочки, а не остаётся только строкой в статусе.
 */
process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const root = await mkdtemp(path.join(tmpdir(), "admin-search-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const MANAGED = [
  "WEB_SEARCH_PROVIDER",
  "YANDEX_SEARCH_API_KEY",
  "YANDEX_SEARCH_FOLDER_ID",
  "YANDEX_FOLDER_ID",
  "TAVILY_API_KEY",
] as const;
const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
for (const name of MANAGED) delete process.env[name];

const Fastify = (await import("fastify")).default;
const { registerAdminSearchRoutes } = await import("./admin-search.js");
const { providerChain } = await import("../web/search.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");

const app = Fastify();
await registerAdminSearchRoutes(app);
await app.ready();

const admin = await createAdmin("search-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
  delete process.env.WEBNESTDEV_STORAGE;
  delete process.env.WEBNESTDEV_DATA_DIR;
  delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
});

test("настройка поиска без входа недоступна", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/search" });
  assert.equal(response.statusCode, 401);
});

test("без ключей бесплатный тариф идёт через DuckDuckGo, платный пока тоже", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/search", headers: auth });
  assert.equal(response.statusCode, 200);
  const search = response.json().search;
  assert.equal(search.provider, "auto");
  assert.equal(search.providerSource, "none");
  assert.equal(search.yandex.configured, false);
  assert.equal(search.yandex.hasKey, false);
  assert.equal(search.tavily.configured, false);
  assert.equal(search.duckduckgo.requiresKey, false);
  assert.deepEqual(search.chains.free, ["duckduckgo"]);
  assert.deepEqual(search.chains.paid, ["duckduckgo"]);
  assert.match(search.note, /ключи поисковых провайдеров не заданы/);
});

test("админка сохраняет провайдера, ключи и каталог, не возвращая секреты", async () => {
  const saved = await app.inject({
    method: "POST",
    url: "/api/admin/search",
    headers: auth,
    payload: {
      provider: "Yandex",
      yandexApiKey: "yandex-search-secret",
      yandexFolderId: "b1g-folder",
      tavilyApiKey: "tvly-search-secret",
    },
  });
  assert.equal(saved.statusCode, 200);
  const search = saved.json().search;
  assert.equal(saved.json().saved, true);
  assert.equal(search.provider, "yandex");
  assert.equal(search.providerSource, "panel");
  assert.equal(search.yandex.configured, true);
  assert.equal(search.yandex.hasKey, true);
  assert.equal(search.yandex.keySource, "panel");
  assert.equal(search.yandex.folderId, "b1g-folder");
  assert.equal(search.yandex.folderSource, "panel");
  assert.equal(search.tavily.configured, true);
  assert.equal(search.tavily.hasKey, true);
  assert.equal(search.tavily.keySource, "panel");
  assert.deepEqual(search.chains.paid, ["yandex", "tavily", "duckduckgo"]);
  assert.ok(!saved.body.includes("yandex-search-secret"));
  assert.ok(!saved.body.includes("tvly-search-secret"));
});

test("сохранённый провайдер участвует в выборе цепочки", () => {
  assert.deepEqual(providerChain("pro").chain, ["yandex", "tavily", "duckduckgo"]);
  assert.deepEqual(providerChain("free").chain, ["duckduckgo"]);
});

test("пустой ключ сохраняет секрет, а clear-флаги удаляют его", async () => {
  const changed = await app.inject({
    method: "POST",
    url: "/api/admin/search",
    headers: auth,
    payload: { provider: "yandex", yandexApiKey: "", tavilyApiKey: "" },
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().search.yandex.hasKey, true);
  assert.equal(changed.json().search.tavily.hasKey, true);

  const cleared = await app.inject({
    method: "POST",
    url: "/api/admin/search",
    headers: auth,
    payload: { clearYandexKey: true, clearTavilyKey: true, clearYandexFolderId: true },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().search.yandex.hasKey, false);
  assert.equal(cleared.json().search.yandex.configured, false);
  assert.equal(cleared.json().search.yandex.folderId, null);
  assert.equal(cleared.json().search.tavily.hasKey, false);
  assert.deepEqual(cleared.json().search.chains.paid, ["duckduckgo"]);
});

test("provider пустой строкой возвращает auto, неверный провайдер отклоняется", async () => {
  const reset = await app.inject({
    method: "POST",
    url: "/api/admin/search",
    headers: auth,
    payload: { provider: "" },
  });
  assert.equal(reset.statusCode, 200);
  assert.equal(reset.json().search.provider, "auto");

  const invalid = await app.inject({
    method: "POST",
    url: "/api/admin/search",
    headers: auth,
    payload: { provider: "google" },
  });
  assert.equal(invalid.statusCode, 400);
});
