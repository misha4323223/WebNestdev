import test from "node:test";
import assert from "node:assert/strict";
import { cloudNotFoundHint, cloudServiceCatalog } from "./catalog.js";

test("каталог MWS называет сервисы и хосты, а не только общий шлюз", () => {
  const mws = cloudServiceCatalog("mws");
  assert.ok(mws.some(entry => entry.prefix === "/compute" && entry.host === "compute.mwsapis.ru"));
  assert.ok(mws.some(entry => entry.prefix === "/rm" && entry.host === "iam.mwsapis.ru"));
  assert.ok(mws.every(entry => entry.example.startsWith(entry.prefix)));
});

test("404 называет похожий сервис и ссылку на документацию", () => {
  const hint = cloudNotFoundHint("mws", "/compute/v1/projects/p/instances");
  assert.match(hint.hint, /404/);
  assert.match(hint.hint, /\/compute/);
  assert.ok(hint.docsUrl?.startsWith("https://"));
  assert.ok(hint.catalog.length > 0);
});

test("неизвестный префикс всё равно получает каталог и документацию", () => {
  const hint = cloudNotFoundHint("timeweb", "/api/v1/unknown");
  assert.match(hint.hint, /каталогом сервисов/);
  assert.ok(hint.catalog.some(entry => entry.example === "/api/v1/servers"));
});
