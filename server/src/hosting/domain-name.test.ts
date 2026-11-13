import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCustomDomainGroup, isCustomDomainHostname, customDomainTxtValue } from "./domain-name.js";

test("apex и www образуют одну группу, canonical выбирает apex", () => {
  const group = normalizeCustomDomainGroup("Example.RU.");
  assert.equal(group.rootDomain, "example.ru");
  assert.deepEqual(group.hostnames.map(item => [item.hostname, item.kind]), [
    ["example.ru", "apex"],
    ["www.example.ru", "www"],
  ]);
  assert.equal(group.hostnames[1].displayHostname, "www.example.ru");
});

test("ввод www даёт ту же пару, а поддомен не получает лишний www", () => {
  const www = normalizeCustomDomainGroup("www.example.ru");
  assert.deepEqual(www.hostnames.map(item => item.hostname), ["example.ru", "www.example.ru"]);

  const shop = normalizeCustomDomainGroup("shop.example.ru");
  assert.equal(shop.rootDomain, "example.ru");
  assert.deepEqual(shop.hostnames.map(item => item.hostname), ["shop.example.ru"]);
  assert.equal(shop.hostnames[0].kind, "subdomain");
});

test("includeWww=false оставляет только запрошенное имя", () => {
  const group = normalizeCustomDomainGroup("example.ru", { includeWww: false });
  assert.deepEqual(group.hostnames.map(item => item.hostname), ["example.ru"]);
});

test("IDN переводится в punycode, но отображается по-человечески", () => {
  const group = normalizeCustomDomainGroup("пример.рф");
  assert.equal(group.hostnames[0].hostname, "xn--e1afmkfd.xn--p1ai");
  assert.equal(group.hostnames[0].displayHostname, "пример.рф");
  assert.equal(group.hostnames[1].hostname, "www.xn--e1afmkfd.xn--p1ai");
});

test("опасные и служебные варианты отклоняются", () => {
  for (const value of [
    "",
    "https://example.ru/path",
    "example.ru:443",
    "*.example.ru",
    "localhost",
    "co.uk",
    "192.0.2.1",
    "example..ru",
    "example.local",
    "custom.nestdev.ru",
    "site.host.nestdev.ru",
  ]) {
    assert.throws(() => normalizeCustomDomainGroup(value), error =>
      Boolean(error && typeof error === "object" && "code" in error && (error as { code: string }).code === "DOMAIN_INVALID"),
      value,
    );
  }
});

test("проверка сохранённого hostname не принимает мусор", () => {
  assert.equal(isCustomDomainHostname("example.ru"), true);
  assert.equal(isCustomDomainHostname("www.example.ru"), true);
  assert.equal(isCustomDomainHostname("xn--e1afmkfd.xn--p1ai"), true);
  assert.equal(isCustomDomainHostname("example"), false);
  assert.equal(isCustomDomainHostname("192.0.2.1"), false);
  assert.equal(isCustomDomainHostname("bad_host.example.ru"), false);
});

test("TXT-значение стабильно и содержит токен", () => {
  assert.equal(customDomainTxtValue("abc"), "nestdev-verify=abc");
});
