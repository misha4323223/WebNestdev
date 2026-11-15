import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  PREVIEW_OWNER_UNAVAILABLE_HINT,
  previewOwnerHealthTtlMs,
  previewOwnerReachable,
  probePreviewOwner,
  resetPreviewOwnerHealthForTests,
  setPreviewOwnerHealthForTests,
} from "./owner-health.js";

afterEach(() => {
  resetPreviewOwnerHealthForTests();
});

test("owner health кеширует положительный ответ и не ходит в дверь на каждый статус", async () => {
  let calls = 0;
  let now = 1_000;
  setPreviewOwnerHealthForTests({
    now: () => now,
    probe: async () => {
      calls++;
      return true;
    },
  });

  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), true);
  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), true);
  assert.equal(calls, 1);

  now += 3_001;
  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), true);
  assert.equal(calls, 2);
});

test("owner health не кеширует отказ дольше своего TTL", async () => {
  let calls = 0;
  let reachable = false;
  let now = 5_000;
  setPreviewOwnerHealthForTests({
    now: () => now,
    probe: async () => {
      calls++;
      return reachable;
    },
  });

  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), false);
  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), false);
  assert.equal(calls, 1);

  reachable = true;
  now += 2_999;
  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), false);
  now += 2;
  assert.equal(await previewOwnerReachable("10.0.0.5:8788"), true);
  assert.equal(calls, 2);
});

test("одновременные проверки одного владельца объединяются", async () => {
  let calls = 0;
  let release: ((value: boolean) => void) | undefined;
  setPreviewOwnerHealthForTests({
    probe: () => {
      calls++;
      return new Promise<boolean>(resolve => {
        release = resolve;
      });
    },
  });

  const first = previewOwnerReachable("10.0.0.5:8788");
  const second = previewOwnerReachable("10.0.0.5:8788");
  assert.equal(calls, 1);
  release?.(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test("некорректный адрес владельца отклоняется без сети", async () => {
  assert.equal(await previewOwnerReachable("https://user:pass@example.test:8788"), false);
  assert.equal(await previewOwnerReachable("not a host"), false);
});

test("реальный probe различает закрытый и открытый порт", async () => {
  const { createServer } = await import("node:net");
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal(await probePreviewOwner("127.0.0.1:" + address.port, 500), true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.equal(await probePreviewOwner("127.0.0.1:" + address.port, 200), false);
});

test("TTL и подсказка доступны снаружи", () => {
  assert.equal(previewOwnerHealthTtlMs("2000"), 2_000);
  assert.match(PREVIEW_OWNER_UNAVAILABLE_HINT, /нода-владелец/i);
});
