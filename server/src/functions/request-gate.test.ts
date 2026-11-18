import assert from "node:assert/strict";
import test from "node:test";
import { RequestGate, RequestGateError, requestGateOptions } from "./request-gate.js";

test("по умолчанию запас растёт вместе с CPU", () => {
  assert.deepEqual(requestGateOptions({} as NodeJS.ProcessEnv, 2), {
    maxInFlight: 128,
    maxQueue: 256,
    waitMs: 2_000,
  });
  assert.deepEqual(requestGateOptions({} as NodeJS.ProcessEnv, 4), {
    maxInFlight: 256,
    maxQueue: 512,
    waitMs: 2_000,
  });
});

test("лимит из env важнее расчёта по CPU", () => {
  assert.deepEqual(requestGateOptions({
    FUNCTIONS_MAX_IN_FLIGHT: "10",
    FUNCTIONS_MAX_IN_FLIGHT_QUEUE: "2",
    FUNCTIONS_MAX_IN_FLIGHT_WAIT_MS: "300",
  } as NodeJS.ProcessEnv, 32), {
    maxInFlight: 10,
    maxQueue: 2,
    waitMs: 300,
  });
});

test("слот освобождается ровно один раз и пускает очередь", async () => {
  const gate = new RequestGate({ maxInFlight: 1, maxQueue: 1, waitMs: 100 });
  const release = await gate.acquire();
  const queued = gate.acquire();
  release();
  release();
  const releaseQueued = await queued;
  releaseQueued();
});

test("переполненная очередь сразу даёт API_BUSY", async () => {
  const gate = new RequestGate({ maxInFlight: 1, maxQueue: 0, waitMs: 100 });
  const release = await gate.acquire();
  await assert.rejects(
    () => gate.acquire(),
    (error: unknown) => error instanceof RequestGateError && error.statusCode === 503,
  );
  release();
});

test("ожидание слота ограничено", async () => {
  const gate = new RequestGate({ maxInFlight: 1, maxQueue: 1, waitMs: 20 });
  const release = await gate.acquire();
  await assert.rejects(
    () => gate.acquire(),
    (error: unknown) => error instanceof RequestGateError && /Не дождались/.test(error.message),
  );
  release();
});
