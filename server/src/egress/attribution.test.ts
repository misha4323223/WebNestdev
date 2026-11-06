import assert from "node:assert/strict";
import test from "node:test";
import { createProjectResolver, whoisLookup } from "./attribution.js";

/**
 * Привязка «адрес → проект» — украшение журнала, а не часть протокола: она обязана быть дешёвой,
 * не повторяться на каждый файл и не задерживать отказ. Поэтому тест держит кеш, отрицательный кеш
 * и предел ожидания.
 */

test("ответ кешируется и не спрашивает API на каждый запрос", async () => {
  let calls = 0;
  let now = 1_000;
  const resolve = createProjectResolver({
    lookup: async address => {
      calls += 1;
      return address === "10.0.0.7" ? "p-1" : null;
    },
    ttlMs: 1_000,
    now: () => now,
  });
  assert.equal(await resolve("10.0.0.7"), "p-1");
  assert.equal(await resolve("10.0.0.7"), "p-1");
  assert.equal(calls, 1);
  now += 5_000;
  assert.equal(await resolve("10.0.0.7"), "p-1");
  assert.equal(calls, 2);
});

test("отрицательный ответ тоже кешируется: контейнеров команд в карте нет", async () => {
  let calls = 0;
  const resolve = createProjectResolver({ lookup: async () => { calls += 1; return null; } });
  assert.equal(await resolve("10.0.0.9"), null);
  assert.equal(await resolve("10.0.0.9"), null);
  assert.equal(calls, 1);
});

test("медленный или падающий API не задерживает отказ и не роняет прокси", async () => {
  const slow = createProjectResolver({
    lookup: () => new Promise(() => undefined),
    timeoutMs: 10,
  });
  assert.equal(await slow("10.0.0.7"), null);
  const broken = createProjectResolver({ lookup: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await broken("10.0.0.7"), null);
});

test("whoisLookup: адрес, токен и разбор ответа", async () => {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, projectId: "p-42" }), { status: 200 });
  }) as typeof fetch;
  const lookup = whoisLookup("http://api:8787/", "token-1", fakeFetch);
  assert.equal(await lookup("10.0.0.7"), "p-42");
  assert.equal(seen[0]?.url, "http://api:8787/api/internal/egress/whois");
  assert.equal(seen[0]?.headers.authorization, "Bearer token-1");
  assert.deepEqual(seen[0]?.body, { address: "10.0.0.7" });
  // Без токена незачем ходить вообще: маршрут всё равно ответит 401.
  const noToken = whoisLookup("http://api:8787", null, fakeFetch);
  assert.equal(await noToken("10.0.0.7"), null);
  assert.equal(seen.length, 1);
});
