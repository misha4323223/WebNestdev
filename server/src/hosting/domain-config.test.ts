import test from "node:test";
import assert from "node:assert/strict";
import {
  customDomainIp,
  customDomainTarget,
  customDomainVerificationHost,
  customDomainsEnabled,
} from "./domain-config.js";

test("target и IP проверяются при чтении, а не попадают в DNS как есть", () => {
  assert.equal(customDomainTarget("custom.example.ru."), "custom.example.ru");
  assert.equal(customDomainIp("178.236.27.102"), "178.236.27.102");
  assert.throws(() => customDomainTarget("https://custom.example.ru"), /DNS/);
  assert.throws(() => customDomainIp("2001:db8::1"), /IPv4/);
  assert.throws(() => customDomainIp("178.236.27.102:443"), /IPv4/);
});

test("verification host строится под каждое имя отдельно", () => {
  assert.equal(customDomainVerificationHost("example.ru"), "_nestdev-verify.example.ru");
  assert.equal(customDomainVerificationHost("www.example.ru"), "_nestdev-verify.www.example.ru");
});

test("feature flag выключен, если переменная не задана как true", () => {
  const previous = process.env.CUSTOM_DOMAINS_ENABLED;
  delete process.env.CUSTOM_DOMAINS_ENABLED;
  assert.equal(customDomainsEnabled(), false);
  process.env.CUSTOM_DOMAINS_ENABLED = "1";
  assert.equal(customDomainsEnabled(), true);
  if (previous === undefined) delete process.env.CUSTOM_DOMAINS_ENABLED;
  else process.env.CUSTOM_DOMAINS_ENABLED = previous;
});
