import test from "node:test";
import assert from "node:assert/strict";
import { providerTimeouts, ProviderTimeoutError, withIdleTimeout } from "./provider-timeouts.js";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("таймауты провайдера по умолчанию: 30 с на соединение и 90 с на простой", () => {
  withEnv({ AI_CONNECT_TIMEOUT_MS: undefined, AI_IDLE_TIMEOUT_MS: undefined }, () => {
    assert.deepEqual(providerTimeouts(), { connectMs: 30_000, idleMs: 90_000 });
  });
});

test("таймауты провайдера читаются из окружения", () => {
  withEnv({ AI_CONNECT_TIMEOUT_MS: "7000", AI_IDLE_TIMEOUT_MS: "45000" }, () => {
    assert.deepEqual(providerTimeouts(), { connectMs: 7_000, idleMs: 45_000 });
  });
});

test("поток, который замолчал, обрывается по простою и отменяет запрос", async () => {
  let cancelled = false;
  async function* stalled() {
    yield "first";
    await new Promise(() => undefined);
  }
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const line of withIdleTimeout(stalled(), 30, () => {
        cancelled = true;
      })) {
        seen.push(line);
      }
    })(),
    (error: unknown) =>
      error instanceof ProviderTimeoutError && error.stage === "idle" && /ETIMEDOUT/.test(error.message),
  );
  assert.deepEqual(seen, ["first"]);
  assert.equal(cancelled, true);
});

test("отмена после таймаута не оставляет необработанный отказ потока", async () => {
  async function* rejectsAfterTimeout() {
    await new Promise(resolve => setTimeout(resolve, 20));
    throw new Error("поток отменён после таймаута");
  }
  await assert.rejects(
    (async () => {
      for await (const line of withIdleTimeout(rejectsAfterTimeout(), 5, () => undefined)) {
        void line;
      }
    })(),
    (error: unknown) => error instanceof ProviderTimeoutError,
  );
  // Даём отклонённому `next()` проявиться: при отсутствии обработчика тест упал бы здесь.
  await new Promise(resolve => setTimeout(resolve, 40));
});

test("живой поток доходит до конца без ложного таймаута", async () => {
  async function* quick() {
    yield "a";
    yield "b";
  }
  const seen: string[] = [];
  for await (const line of withIdleTimeout(quick(), 1000, () => assert.fail("не должно быть отмены"))) {
    seen.push(line);
  }
  assert.deepEqual(seen, ["a", "b"]);
});
