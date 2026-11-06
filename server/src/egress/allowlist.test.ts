import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEgress,
  defaultEgressAllowlist,
  describeEgressDeny,
  egressAllowlist,
  hostAllowlisted,
  hostMatches,
  isMetadataAddress,
  isPrivateAddress,
  normalizeEgressHost,
} from "./allowlist.js";
import { describeEgress, egressMode, egressProxyEnv, egressProxyUrl } from "./config.js";

/**
 * Правила фильтра — единственное место, где решается «пускать или нет». Ошибка здесь либо
 * открывает нашу внутреннюю сеть (приватный адрес под видом домена заказчика), либо ломает
 * установку пакетов во всех проектах сразу, поэтому проверяются обе стороны: что закрыто и что
 * открыто.
 */

test("приватные диапазоны и metadata закрыты, публичные адреса — нет", () => {
  for (const address of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  assert.equal(isMetadataAddress("169.254.169.254"), true);
  assert.equal(isMetadataAddress("fd00:ec2::254"), true);
  assert.equal(isMetadataAddress("1.2.3.4", "metadata.google.internal"), true);
  assert.equal(isMetadataAddress("1.2.3.4", "example.com"), false);
});

test("шаблоны allowlist: точный домен и поддомены через *.", () => {
  assert.equal(hostMatches("registry.npmjs.org", "registry.npmjs.org"), true);
  assert.equal(hostMatches("REGISTRY.NPMJS.ORG.", "registry.npmjs.org"), true);
  assert.equal(hostMatches("a.npmjs.org", "*.npmjs.org"), true);
  assert.equal(hostMatches("a.b.npmjs.org", "*.npmjs.org"), true);
  assert.equal(hostMatches("npmjs.org", "*.npmjs.org"), false, "сам домен не покрывается поддоменом");
  assert.equal(hostMatches("evilnpmjs.org", "*.npmjs.org"), false, "суффикс без точки не подходит");
  assert.equal(hostAllowlisted("a.npmjs.org", defaultEgressAllowlist()), true);
  assert.equal(hostAllowlisted("example.com", defaultEgressAllowlist()), false);
  // Список дополняется, а не заменяется: иначе опечатка в .env выключила бы установку пакетов.
  const merged = egressAllowlist("example.com, api.заказчик.рф");
  assert.equal(hostAllowlisted("registry.npmjs.org", merged), true);
  assert.equal(hostAllowlisted("example.com", merged), true);
});

test("checkEgress: allowlist пускает реестр и не пускает посторонний домен", () => {
  const allowlist = defaultEgressAllowlist();
  assert.deepEqual(checkEgress("registry.npmjs.org", 443, "104.16.0.1", { mode: "allowlist", allowlist }), { allowed: true });
  assert.deepEqual(checkEgress("example.com", 443, "93.184.216.34", { mode: "allowlist", allowlist }), {
    allowed: false,
    reason: "not-allowlisted",
  });
  // Разрешённый домен, который резолвится внутрь нашей сети, — по-прежнему отказ.
  assert.deepEqual(checkEgress("registry.npmjs.org", 443, "10.0.0.5", { mode: "allowlist", allowlist }), {
    allowed: false,
    reason: "private",
  });
  assert.deepEqual(checkEgress("registry.npmjs.org", 443, "169.254.169.254", { mode: "allowlist", allowlist }), {
    allowed: false,
    reason: "metadata",
  });
  assert.deepEqual(checkEgress("registry.npmjs.org", 22, "104.16.0.1", { mode: "allowlist", allowlist }), {
    allowed: false,
    reason: "bad-port",
  });
  assert.deepEqual(checkEgress("", 443, "1.1.1.1", { mode: "allowlist", allowlist }), { allowed: false, reason: "bad-host" });
});

test("checkEgress: private-only пускает публичное и закрывает внутреннее", () => {
  assert.deepEqual(checkEgress("example.com", 443, "93.184.216.34", { mode: "private-only" }), { allowed: true });
  assert.deepEqual(checkEgress("internal.example", 443, "192.168.0.10", { mode: "private-only" }), {
    allowed: false,
    reason: "private",
  });
  // Литеральный IP в адресе: имя хоста и есть адрес.
  assert.deepEqual(checkEgress("10.0.0.1", 80, "", { mode: "private-only" }), { allowed: false, reason: "private" });
  assert.deepEqual(checkEgress("1.1.1.1", 80, "", { mode: "private-only" }), { allowed: true });
});

test("normalizeEgressHost отбрасывает мусор из заголовка", () => {
  assert.equal(normalizeEgressHost(" Example.COM. "), "example.com");
  assert.equal(normalizeEgressHost("[::1]"), "::1");
  assert.equal(normalizeEgressHost("пример.рф"), null);
  assert.equal(normalizeEgressHost(""), null);
});

test("причина отказа объясняет человеку, что случилось", () => {
  assert.match(describeEgressDeny("not-allowlisted", "example.com"), /не входит в список/);
  assert.match(describeEgressDeny("private", "10.0.0.1"), /приватные адреса/);
});

test("режим и адрес прокси: off — прежнее поведение, опечатка — ошибка", () => {
  assert.equal(egressMode({}), "off");
  assert.equal(egressMode({ EGRESS_PROXY_ENABLED: "1" }), "allowlist");
  assert.equal(egressMode({ EGRESS_MODE: "private-only" }), "private-only");
  assert.equal(egressMode({ EGRESS_MODE: "off" }), "off");
  assert.throws(() => egressMode({ EGRESS_MODE: "allowlst" }), /не поддерживается/);
  assert.equal(egressProxyUrl({}), "http://webnestdev-server:3128");
  assert.equal(egressProxyUrl({ EGRESS_PROXY_URL: "http://proxy.local:9999/" }), "http://proxy.local:9999");
  assert.match(describeEgress({ EGRESS_MODE: "allowlist" }), /allowlist включён/);
});

test("переменные прокси в контейнер: выключенный фильтр ничего не передаёт", () => {
  assert.deepEqual(egressProxyEnv({}), {});
  const env = egressProxyEnv({ EGRESS_MODE: "allowlist" });
  assert.equal(env.HTTPS_PROXY, "http://webnestdev-server:3128");
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.npm_config_https_proxy, env.HTTPS_PROXY);
  // Локальная петля контейнера — не наружу, и прокси ей не нужен.
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
});
