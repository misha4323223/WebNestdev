import test from "node:test";
import assert from "node:assert/strict";
import { functionCacheInvalidationChannel, invalidateFunctionCache } from "./cache-invalidation.js";
import { assertNotificationChannel } from "../storage/pg-notifications.js";

test("invalidates the site locally and notifies other nodes", async () => {
  const cleared: string[] = [];
  const notified: string[] = [];
  const result = await invalidateFunctionCache("site-1", {
    clearSite: siteId => cleared.push(siteId),
    notify: async siteId => { notified.push(siteId); },
  });
  assert.deepEqual(cleared, ["site-1"]);
  assert.deepEqual(notified, ["site-1"]);
  assert.deepEqual(result, { local: true, notified: true });
});

test("keeps the local invalidation when the notification fails", async () => {
  let cleared = 0;
  const result = await invalidateFunctionCache("site-2", {
    clearSite: () => { cleared += 1; },
    notify: async () => { throw new Error("pg unavailable"); },
  });
  assert.equal(cleared, 1);
  assert.equal(result.local, true);
  assert.equal(result.notified, false);
  assert.equal(result.error, "pg unavailable");
});

test("channel name is a safe identifier and includes the table prefix", () => {
  const channel = functionCacheInvalidationChannel();
  assert.equal(assertNotificationChannel(channel), channel);
  assert.match(channel, /^[a-z_][a-z0-9_]+$/);
  assert.throws(() => assertNotificationChannel('cache"; DROP TABLE users; --'), /Некорректное имя канала/);
});
