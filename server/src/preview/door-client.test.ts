import assert from "node:assert/strict";
import test from "node:test";
import { lookupPreview, probePreviewDoor, reportPreviewEvent, resetPreviewLookupCache } from "./door-client.js";
import { previewDoorToken } from "./door-token.js";

/**
 * Клиент двери — единственный канал, которым отдельный процесс узнаёт состояние предпросмотра.
 * Тест держит то, что иначе видно только в бою: каскад файлов приложения не должен стоить запроса
 * к API на каждый файл, отрицательный ответ не должен залипать (проект могли только что открыть),
 * недоступный API обязан быть ошибкой, а не «предпросмотра нет».
 */

const KEY = "d".repeat(64);

function withKey<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.WEBNESTDEV_ENCRYPTION_KEY;
  process.env.WEBNESTDEV_ENCRYPTION_KEY = KEY;
  return run().finally(() => {
    if (previous === undefined) delete process.env.WEBNESTDEV_ENCRYPTION_KEY;
    else process.env.WEBNESTDEV_ENCRYPTION_KEY = previous;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RUNNING = {
  running: true,
  ready: true,
  port: 3000,
  host: "10.0.0.7",
  containerId: "abc",
  startedAt: 1,
  mode: "container",
};

test("положительный ответ живёт в кеше: каскад файлов не бьёт по API на каждый файл", async () => {
  await withKey(async () => {
    resetPreviewLookupCache();
    let calls = 0;
    let now = 1_000;
    const stub = (async () => {
      calls += 1;
      return jsonResponse({ ok: true, exists: true, status: RUNNING });
    }) as unknown as typeof fetch;
    const options = { fetch: stub, now: () => now, cacheMs: 1_000 };
    const first = await lookupPreview("p1", options);
    now += 500;
    const second = await lookupPreview("p1", options);
    assert.equal(calls, 1);
    assert.deepEqual(first, second);
    assert.equal(first.exists, true);
    assert.equal(first.status.running, true);
    now += 600;
    await lookupPreview("p1", options);
    assert.equal(calls, 2, "после истечения кеша состояние спрашивается снова");
  });
});

test("отрицательный ответ не кешируется: проект могли открыть только что", async () => {
  await withKey(async () => {
    resetPreviewLookupCache();
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return jsonResponse({ ok: true, exists: false, status: { running: false } });
    }) as unknown as typeof fetch;
    const options = { fetch: stub, now: () => 1_000, cacheMs: 60_000 };
    assert.deepEqual(await lookupPreview("missing", options), { exists: false, status: { running: false } });
    assert.deepEqual(await lookupPreview("missing", options), { exists: false, status: { running: false } });
    assert.equal(calls, 2);
  });
});

test("недоступный API — ошибка, а не «предпросмотр не запущен»", async () => {
  await withKey(async () => {
    resetPreviewLookupCache();
    const stub = (async () => jsonResponse({ ok: false }, 500)) as unknown as typeof fetch;
    await assert.rejects(() => lookupPreview("p1", { fetch: stub, now: () => 0 }), /ответил 500/);
  });
});

test("кривая форма ответа не превращается в адрес undefined", async () => {
  await withKey(async () => {
    resetPreviewLookupCache();
    const stub = (async () => jsonResponse({ ok: true, exists: true, status: { running: "yes", host: "x" } })) as unknown as typeof fetch;
    const result = await lookupPreview("p1", { fetch: stub, now: () => 0 });
    assert.deepEqual(result, { exists: true, status: { running: false } });
  });
});

test("дверь представляется токеном, выведенным из ключа", async () => {
  await withKey(async () => {
    resetPreviewLookupCache();
    let authorization = "";
    const stub = (async (_url: unknown, init?: RequestInit) => {
      authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
      return jsonResponse({ ok: true, exists: true, status: RUNNING });
    }) as unknown as typeof fetch;
    await lookupPreview("p1", { fetch: stub, now: () => 0, token: previewDoorToken() });
    assert.equal(authorization, "Bearer " + previewDoorToken());
  });
});

test("событие двери уходит тем же токеном, а его недоставка не бросает", async () => {
  await withKey(async () => {
    const bodies: string[] = [];
    const ok = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    await reportPreviewEvent("p1", "exec-only", true, { fetch: ok });
    assert.deepEqual(JSON.parse(bodies[0] ?? "{}"), { projectId: "p1", event: "exec-only", value: true });
    const failing = (async () => {
      throw new Error("сети нет");
    }) as unknown as typeof fetch;
    await assert.doesNotReject(() => reportPreviewEvent("p1", "unsettle", undefined, { fetch: failing }));
  });
});

test("probePreviewDoor: живая дверь отдаёт лимиты, мёртвая — причину", async () => {
  const live = (async () =>
    jsonResponse({
      ok: true,
      service: "preview-door",
      limits: { maxConnections: 256, maxUpgrades: 64, upgradeTimeoutMs: 10_000 },
      live: { connections: 7, upgrades: 2 },
      uptimeSeconds: 42,
    })) as unknown as typeof fetch;
  const state = await probePreviewDoor({ fetch: live, url: "http://door.local/__health" });
  assert.equal(state.live, true);
  assert.equal(state.connections, 7);
  assert.equal(state.upgrades, 2);
  assert.equal(state.uptimeSeconds, 42);
  assert.equal(state.limits?.maxConnections, 256);

  const broken = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  const down = await probePreviewDoor({ fetch: broken, url: "http://door.local/__health" });
  assert.equal(down.live, false);
  assert.match(down.reason ?? "", /ECONNREFUSED/);
});
