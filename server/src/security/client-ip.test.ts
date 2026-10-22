import test from "node:test";
import assert from "node:assert/strict";
import { addressInRange, describeTrustProxy, isTrustedProxy, normalizeAddress, trustProxyOption, trustedProxyList } from "./client-ip.js";

test("адрес приводится к одной форме независимо от записи", () => {
  assert.equal(normalizeAddress("::ffff:172.30.0.10"), "172.30.0.10");
  assert.equal(normalizeAddress("[::1]"), "::1");
  assert.equal(normalizeAddress(" 127.0.0.1 "), "127.0.0.1");
});

test("точный адрес и IPv4-сеть сравниваются верно", () => {
  assert.equal(addressInRange("172.30.0.10", "172.30.0.10"), true);
  assert.equal(addressInRange("172.30.0.11", "172.30.0.10"), false);
  assert.equal(addressInRange("172.30.4.7", "172.30.0.0/16"), true);
  assert.equal(addressInRange("172.31.4.7", "172.30.0.0/16"), false);
  assert.equal(addressInRange("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(addressInRange("11.1.2.3", "10.0.0.0/8"), false);
  // IPv6 нужен только для loopback: сеток IPv6 в Docker здесь нет.
  assert.equal(addressInRange("::1", "::1"), true);
  assert.equal(addressInRange("::2", "::1"), false);
});

test("по умолчанию доверяется только loopback, остальное — из окружения", () => {
  assert.deepEqual(trustedProxyList(""), ["127.0.0.1", "::1"]);
  assert.deepEqual(trustedProxyList(" 172.30.0.10 , 172.30.0.0/24 "), ["172.30.0.10", "172.30.0.0/24"]);
  assert.equal(isTrustedProxy("127.0.0.1", ["127.0.0.1"]), true);
  assert.equal(isTrustedProxy("::ffff:127.0.0.1", ["127.0.0.1"]), true);
  assert.equal(isTrustedProxy("172.30.0.20", ["172.30.0.10"]), false);
  assert.equal(isTrustedProxy("172.30.0.20", ["172.30.0.0/24"]), true);
  assert.equal(isTrustedProxy(undefined, ["127.0.0.1"]), false);
});

/**
 * `trustProxy: true` доверяет `X-Forwarded-For` кому угодно — тогда лимиты обходятся одним лишним
 * заголовком. Настройка обязана быть функцией от адреса соединения.
 */
test("опция trustProxy принимает решение только по адресу соединения", () => {
  const option = trustProxyOption(["172.30.0.10"]);
  assert.equal(typeof option, "function");
  assert.ok(option);
  assert.equal(option("172.30.0.10"), true);
  assert.equal(option("172.30.0.11"), false);
  assert.match(describeTrustProxy(["172.30.0.10"]), /172\.30\.0\.10/);
});
