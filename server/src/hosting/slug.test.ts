import test from "node:test";
import assert from "node:assert/strict";
import { hostSlugForDomain, isHostingSlug, newHostingSlug } from "./slug.js";

test("slug — ровно 12 строчных hex-символов", () => {
  for (let index = 0; index < 20; index++) assert.match(newHostingSlug(), /^[a-f0-9]{12}$/);
  assert.equal(isHostingSlug(".."), false);
  assert.equal(isHostingSlug("a1b2c3d4e5f6"), true);
  assert.equal(isHostingSlug("A1B2C3D4E5F6"), false);
});

test("hostSlugForDomain понимает порт и отвергает вложенные/чужие имена", () => {
  const domain = "host.nestdev.ru";
  assert.equal(hostSlugForDomain("a1b2c3d4e5f6.host.nestdev.ru", domain), "a1b2c3d4e5f6");
  assert.equal(hostSlugForDomain("A1B2C3D4E5F6.HOST.NESTDEV.RU:443", domain), "a1b2c3d4e5f6");
  assert.equal(hostSlugForDomain("a1b2c3d4e5f6.host.nestdev.ru.", domain), "a1b2c3d4e5f6");
  assert.equal(hostSlugForDomain("host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("..host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("a.b.host.nestdev.ru", domain), null);
  assert.equal(hostSlugForDomain("a1b2c3d4e5f6.host.evil.ru", domain), null);
});
