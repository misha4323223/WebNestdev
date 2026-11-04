import test from "node:test";
import assert from "node:assert/strict";
import { hostSlugForDomain, isHostingSlug, newHostingSlug, normalizeHostingSlug } from "./slug.js";

test("сгенерированный slug — ровно 12 строчных hex-символов, пользовательский — DNS-метка", () => {
  for (let index = 0; index < 20; index++) assert.match(newHostingSlug(), /^[a-f0-9]{12}$/);
  assert.equal(isHostingSlug(".."), false);
  assert.equal(isHostingSlug("a1b2c3d4e5f6"), true);
  assert.equal(isHostingSlug("A1B2C3D4E5F6"), false);
  assert.equal(isHostingSlug("my-site"), true);
  assert.equal(isHostingSlug("my--site"), true);
  assert.equal(isHostingSlug("ab"), false);
  assert.equal(isHostingSlug("my_site"), false);
  assert.equal(isHostingSlug("www"), false);
  assert.equal(isHostingSlug("xn--e1afmkfd"), false);
  assert.equal(isHostingSlug("my-site-"), false);
});

test("normalizeHostingSlug снимает URL, домен и приводит безопасное имя", () => {
  assert.equal(normalizeHostingSlug("  My Site  ", "host.nestdev.ru"), "my-site");
  assert.equal(normalizeHostingSlug("https://My-Site.host.nestdev.ru/page?q=1", "host.nestdev.ru"), "my-site");
  assert.equal(normalizeHostingSlug("my_site", "host.nestdev.ru"), "my-site");
  assert.equal(normalizeHostingSlug("my-site-", "host.nestdev.ru"), "my-site");
  assert.throws(() => normalizeHostingSlug("ab", "host.nestdev.ru"), /3–63/);
  assert.throws(() => normalizeHostingSlug("мой-сайт", "host.nestdev.ru"), /латинские/);
  assert.throws(() => normalizeHostingSlug("www", "host.nestdev.ru"), /зарезервирован/);
  assert.throws(() => normalizeHostingSlug("my.site.example", "host.nestdev.ru"), /без домена/);
});

test("hostSlugForDomain понимает порт и отвергает вложенные/чужие имена", () => {
  const domain = "host.nestdev.ru";
  assert.equal(hostSlugForDomain("a1b2c3d4e5f6.host.nestdev.ru", domain), "a1b2c3d4e5f6");
  assert.equal(hostSlugForDomain("my-site.host.nestdev.ru", domain), "my-site");
  assert.equal(hostSlugForDomain("A1B2C3D4E5F6.HOST.NESTDEV.RU:443", domain), "a1b2c3d4e5f6");
  assert.equal(hostSlugForDomain("a1b2c3d4e5f6.host.nestdev.ru.", domain), "a1b2c3d4e5f6");
  assert.equal(hostSlugForDomain("my_site.host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("..host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("a.b.host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("a1b2c3d4e5f6.host.evil.ru", domain), null);
});
