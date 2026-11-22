import test from "node:test";
import assert from "node:assert/strict";
import { cloudNotFoundHint, cloudServiceCatalog } from "./catalog.js";

test("каталог MWS называет сервисы и хосты, а не только общий шлюз", () => {
  const mws = cloudServiceCatalog("mws");
  assert.ok(mws.some(entry => entry.prefix === "/compute" && entry.host === "compute.mwsapis.ru"));
  assert.ok(mws.some(entry => entry.prefix === "/rm" && entry.host === "iam.mwsapis.ru"));
  assert.ok(mws.every(entry => entry.example.startsWith(entry.prefix)));
});

test("примеры Cloud.ru и Timeweb указывают реальные хосты и пути", () => {
  const cloudru = cloudServiceCatalog("cloudru");
  assert.ok(cloudru.some(entry => entry.prefix === "/api/v1/vms" && entry.host === "compute.api.cloud.ru"));
  assert.ok(cloudru.some(entry => entry.prefix === "/v3/projects" && entry.host === "organization.api.cloud.ru"));
  assert.ok(!cloudru.some(entry => entry.prefix === "/v3/vms"), "старый неверный путь не должен возвращаться");
  const timeweb = cloudServiceCatalog("timeweb");
  assert.ok(timeweb.some(entry => entry.example === "/api/v1/storages/buckets"));
  assert.ok(!timeweb.some(entry => entry.prefix === "/api/v1/s3-storages"));
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
