import assert from "node:assert/strict";
import test from "node:test";
import { clearProxyAddressCache, ipv4InCidr, proxyUrlForNetwork } from "./proxy-address.js";

/**
 * Почему адрес прокси вообще считается по IP.
 *
 * `npm install` падал с `getaddrinfo EAI_AGAIN webnestdev-server`: установка разрешала имя прокси
 * внутри песочницы, и на нагруженном gVisor этот запрос истекал. Фильтр при этом работал, пакеты
 * через прокси шли — ломался только DNS. Эти тесты фиксируют, что адрес берётся из своей сети,
 * не из сети с базой, и что при любой неизвестности остаётся прежний адрес по имени.
 */

const PREVIEW_NETWORK = "webnestdev-preview";

test("IPv4 проверяется по подсети, а не по префиксу строки", () => {
  assert.equal(ipv4InCidr("172.31.0.7", "172.31.0.0/24"), true);
  assert.equal(ipv4InCidr("172.31.0.7", "172.30.0.0/24"), false);
  // 172.31.0.7 не входит в /25, где только .0–.127? Входит; проверяем настоящую границу.
  assert.equal(ipv4InCidr("172.31.0.200", "172.31.0.0/25"), false);
  assert.equal(ipv4InCidr("172.31.0.200", "172.31.0.0/16"), true);
  assert.equal(ipv4InCidr("172.31.0.7", "172.31.0.0/32"), false);
  assert.equal(ipv4InCidr("172.31.0.0", "172.31.0.0/32"), true);
  assert.equal(ipv4InCidr("::1", "172.31.0.0/24"), false);
  assert.equal(ipv4InCidr("172.31.0.7", "мусор"), false);
  assert.equal(ipv4InCidr("172.31.0.7", "172.31.0.0/99"), false);
});

test("берётся свой адрес в сети предпросмотра, а не в сети с базой", async () => {
  clearProxyAddressCache();
  const url = await proxyUrlForNetwork(PREVIEW_NETWORK, {
    env: { EGRESS_MODE: "allowlist", EGRESS_PROXY_PORT: "3128" },
    addresses: () => ["127.0.0.1", "172.30.0.5", "172.31.0.7"],
    inspect: async () => JSON.stringify([{ Subnet: "172.31.0.0/24" }]),
  });
  assert.equal(url, "http://172.31.0.7:3128");
});

test("адрес кешируется: повторный запуск не читает сеть заново", async () => {
  clearProxyAddressCache();
  let calls = 0;
  const deps = {
    env: { EGRESS_MODE: "allowlist" },
    addresses: () => ["172.31.0.7"],
    inspect: async () => {
      calls++;
      return JSON.stringify([{ Subnet: "172.31.0.0/24" }]);
    },
  };
  assert.equal(await proxyUrlForNetwork(PREVIEW_NETWORK, deps), "http://172.31.0.7:3128");
  assert.equal(await proxyUrlForNetwork(PREVIEW_NETWORK, deps), "http://172.31.0.7:3128");
  assert.equal(calls, 1);
});

test("явный EGRESS_PROXY_URL главнее вычисленного адреса", async () => {
  clearProxyAddressCache();
  let inspected = false;
  const url = await proxyUrlForNetwork(PREVIEW_NETWORK, {
    env: { EGRESS_MODE: "allowlist", EGRESS_PROXY_URL: "http://proxy.internal:3128/" },
    addresses: () => ["172.31.0.7"],
    inspect: async () => {
      inspected = true;
      return JSON.stringify([{ Subnet: "172.31.0.0/24" }]);
    },
  });
  assert.equal(url, "http://proxy.internal:3128");
  assert.equal(inspected, false);
});

test("адрес по умолчанию из compose не считается выбором оператора", async () => {
  clearProxyAddressCache();
  // На проде compose всегда выставляет EGRESS_PROXY_URL через `${…:-…}`, и это ровно то же имя.
  // Если принять его за явное указание, IP никогда не вычислится и EAI_AGAIN вернётся.
  const url = await proxyUrlForNetwork(PREVIEW_NETWORK, {
    env: { EGRESS_MODE: "allowlist", EGRESS_PROXY_URL: "http://webnestdev-server:3128" },
    addresses: () => ["172.31.0.7"],
    inspect: async () => JSON.stringify([{ Subnet: "172.31.0.0/24" }]),
  });
  assert.equal(url, "http://172.31.0.7:3128");
});

test("сеть не прочиталась — остаётся прежний адрес по имени", async () => {
  clearProxyAddressCache();
  const url = await proxyUrlForNetwork(PREVIEW_NETWORK, {
    env: { EGRESS_MODE: "allowlist", EGRESS_PROXY_HOST: "webnestdev-server" },
    addresses: () => ["172.31.0.7"],
    inspect: async () => {
      throw new Error("docker недоступен");
    },
  });
  assert.equal(url, "http://webnestdev-server:3128");
});

test("своего адреса в сети нет — тоже откат на имя, без ложного IP", async () => {
  clearProxyAddressCache();
  const url = await proxyUrlForNetwork(PREVIEW_NETWORK, {
    env: { EGRESS_MODE: "allowlist", EGRESS_PROXY_HOST: "webnestdev-server" },
    addresses: () => ["10.0.0.2"],
    inspect: async () => JSON.stringify([{ Subnet: "172.31.0.0/24" }]),
  });
  assert.equal(url, "http://webnestdev-server:3128");
});

test("без фильтра и в чужих сетях прокси не нужен", async () => {
  clearProxyAddressCache();
  for (const network of ["none", "bridge", "default", ""]) {
    assert.equal(await proxyUrlForNetwork(network, { env: { EGRESS_MODE: "allowlist" } }), "", network);
  }
  assert.equal(await proxyUrlForNetwork(PREVIEW_NETWORK, { env: { EGRESS_MODE: "off" } }), "");
});
