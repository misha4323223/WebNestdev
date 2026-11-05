import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAuthRateLimit, clearAuthRateLimits } from "./auth-rate-limit.js";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "auth-rate-limit-"));

/**
 * Две двери считаются независимо: адрес останавливает веер по аккаунтам, аккаунт — перебор с
 * разных адресов. Раньше был только счётчик адреса, и за прокси он превращался в один общий на
 * всю платформу — это и проверяется здесь по обеим сторонам.
 */
test("перебор одного аккаунта с разных адресов упирается в лимит аккаунта", async () => {
  await clearAuthRateLimits();
  const email = "victim@example.test";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await checkAuthRateLimit("10.0.0." + (attempt + 1), "login", email);
    assert.equal(result.allowed, true, "попытка " + (attempt + 1) + " должна пройти");
  }
  const blocked = await checkAuthRateLimit("10.0.1.1", "login", email);
  assert.equal(blocked.allowed, false);
  assert.ok(!blocked.allowed && blocked.retryAfter > 0);

  // Другой аккаунт с того же адреса не заблокирован: счётчики не общие.
  const other = await checkAuthRateLimit("10.0.1.1", "login", "other@example.test");
  assert.equal(other.allowed, true);
});

test("веер по многим аккаунтам с одного адреса упирается в лимит адреса", async () => {
  await clearAuthRateLimits();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await checkAuthRateLimit("10.9.9.9", "login", "user" + attempt + "@example.test");
    assert.equal(result.allowed, true, "попытка " + (attempt + 1) + " должна пройти");
  }
  const blocked = await checkAuthRateLimit("10.9.9.9", "login", "new@example.test");
  assert.equal(blocked.allowed, false);
});

test("без email проверяется только адрес, а разные действия не смешиваются", async () => {
  await clearAuthRateLimits();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await checkAuthRateLimit("10.5.5.5", "register")).allowed, true);
  }
  assert.equal((await checkAuthRateLimit("10.5.5.5", "register")).allowed, false);
  // Вход с того же адреса — отдельный счётчик, регистрация его не исчерпала.
  assert.equal((await checkAuthRateLimit("10.5.5.5", "login", "someone@example.test")).allowed, true);
});

test("счётчики не в памяти процесса: окно видно в хранилище и переживает перезагрузку модуля", async () => {
  await clearAuthRateLimits();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await checkAuthRateLimit("10.7.7.7", "login", "stored@example.test");
  }
  // Файл — это то же хранилище, из которого читает следующий процесс: в памяти такого следа нет.
  const raw = await readFile(path.join(process.env.WEBNESTDEV_DATA_DIR!, "rate-limits.json"), "utf8");
  const buckets = JSON.parse(raw) as Record<string, { count: number; resetAt: number }>;
  assert.equal(buckets["subject:login:stored@example.test"]?.count, 8);
  assert.ok(buckets["ip:login:10.7.7.7"]?.resetAt > Date.now());
});
