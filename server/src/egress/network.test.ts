import assert from "node:assert/strict";
import test from "node:test";
import { proxyReachableFrom, sandboxNetwork } from "./network.js";

/**
 * Сеть для установок. Ошибка здесь ломает `npm install` во всех проектах: контейнер получит адрес
 * прокси, до которого не дотягивается, — и человек увидит не «фильтр», а «EAI_AGAIN».
 */

test("без фильтра «нужен интернет» остаётся bridge", async () => {
  assert.equal(await sandboxNetwork("bridge", {}), "bridge");
  assert.equal(await sandboxNetwork("none", { EGRESS_MODE: "allowlist" }), "none");
  assert.equal(await sandboxNetwork("webnestdev-preview", { EGRESS_MODE: "allowlist" }), "webnestdev-preview");
});

test("переменные прокси — только там, где прокси достижим", () => {
  for (const network of ["none", "bridge", "default", ""]) {
    assert.equal(proxyReachableFrom(network), false, network);
  }
  assert.equal(proxyReachableFrom("webnestdev-preview"), true);
  assert.equal(proxyReachableFrom("src_webnestdev-preview"), true);
});
