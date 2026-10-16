import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerPanelFiles } from "./panel-static.js";

const DOCUMENT = '<!doctype html><html><head><script type="module" src="/assets/app-1a2b3c.js"></script></head><body><div id="root"></div></body></html>';

/** Собранная панель: документ, файл сборки с хэшем в имени и файл без хэша. */
async function builtPanel() {
  const dir = await mkdtemp(path.join(tmpdir(), "panel-static-"));
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await mkdir(path.join(dir, "brand"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), DOCUMENT);
  await writeFile(path.join(dir, "assets", "app-1a2b3c.js"), "console.log(1);\n");
  await writeFile(path.join(dir, "brand", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function panelApp(dir: string) {
  const app = Fastify();
  assert.equal(await registerPanelFiles(app, dir), true);
  await app.ready();
  return app;
}

/**
 * Документ не должен ни жить в кэше, ни подтверждаться по валидатору: с `etag` посредник вправе
 * ответить `304 Not Modified`, и вкладка остаётся на прошлой сборке — вместе со ссылками на её
 * ассеты, которые лежат в кэше 30 дней и потому продолжают работать. Это ровно то, что выглядит как
 * «после выкатки показывается старая версия».
 */
test("the document is never cached and carries no validator to confirm a stale copy with", async () => {
  const panel = await builtPanel();
  const app = await panelApp(panel.dir);
  try {
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.equal(root.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
    assert.equal(root.headers.pragma, "no-cache");
    assert.equal(root.headers.expires, "0");
    assert.equal(root.headers.etag, undefined, "с etag посредник мог бы ответить 304 и оставить старый документ");
    assert.equal(root.headers["last-modified"], undefined);
    assert.match(String(root.headers["content-type"]), /text\/html/);

    // Даже если посредник пришёл со своим etag, ответ — полный документ, а не 304.
    const conditional = await app.inject({ method: "GET", url: "/", headers: { "if-none-match": 'W/"old-build"' } });
    assert.equal(conditional.statusCode, 200);
    assert.equal(conditional.body, DOCUMENT);

    // SPA-фолбэк отдаёт тот же документ: адрес мог быть закэширован посредником отдельно от корня.
    const route = await app.inject({ method: "GET", url: "/projects/abc?tab=preview" });
    assert.equal(route.statusCode, 200);
    assert.equal(route.body, DOCUMENT);
    assert.equal(route.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
    assert.equal(route.headers.etag, undefined);
    assert.equal(route.headers["last-modified"], undefined);
  } finally {
    await app.close();
    await panel.cleanup();
  }
});

test("build files stay cached by their hashed name and unhashed files are revalidated", async () => {
  const panel = await builtPanel();
  const app = await panelApp(panel.dir);
  try {
    // Хэш в имени — новая сборка приходит с новыми именами, поэтому 30 дней тут безопасны.
    const asset = await app.inject({ method: "GET", url: "/assets/app-1a2b3c.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers["cache-control"]), /immutable/);

    // Файл без хэша может измениться на месте — сервер спрашивают при каждой загрузке.
    const icon = await app.inject({ method: "GET", url: "/brand/icon.png" });
    assert.equal(icon.statusCode, 200);
    assert.equal(icon.headers["cache-control"], "no-cache");
  } finally {
    await app.close();
    await panel.cleanup();
  }
});

test("without a built panel nothing is registered, so a source run still starts", async () => {
  const app = Fastify();
  try {
    assert.equal(await registerPanelFiles(app, path.join(tmpdir(), "panel-static-missing-" + Date.now())), false);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/" });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});
