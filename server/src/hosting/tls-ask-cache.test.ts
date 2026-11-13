import test from "node:test";
import assert from "node:assert/strict";
import { cachedCustomDomainForTls, clearCustomDomainTlsCache } from "./tls-ask-cache.js";
import type { CustomDomain } from "./domain-types.js";

const domain = {
  id: "d1",
  hostname: "cached-example.ru",
} as CustomDomain;

test("кеширует положительный и отрицательный ответ на короткий TTL", async () => {
  clearCustomDomainTlsCache();
  let calls = 0;
  const load = async () => {
    calls++;
    return calls === 1 ? domain : null;
  };
  assert.equal(await cachedCustomDomainForTls(domain.hostname, load, 1_000), domain);
  assert.equal(await cachedCustomDomainForTls(domain.hostname, load, 1_500), domain);
  assert.equal(calls, 1);

  assert.equal(await cachedCustomDomainForTls(domain.hostname, load, 20_000), null);
  assert.equal(await cachedCustomDomainForTls(domain.hostname, load, 20_100), null);
  assert.equal(calls, 2);
  clearCustomDomainTlsCache();
});
