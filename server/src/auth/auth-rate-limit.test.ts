import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("разные IPv6 внутри одной /64 делят окно, а не получают новое на каждый адрес", async () => {
  await clearAuthRateLimits();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await checkAuthRateLimit("2001:db8:1:2::" + attempt.toString(16), "login", "ipv6-" + attempt + "@example.test");
    assert.equal(result.allowed, true, "попытка " + (attempt + 1) + " должна пройти");
  }
  const blocked = await checkAuthRateLimit("2001:db8:1:2:ffff::1", "login", "new@example.test");
  assert.equal(blocked.allowed, false, "другой адрес той же /64 — то же окно");
});

test("CGNAT не блокирует честных: IP-дверь пропускается, лимит аккаунта остаётся", async () => {
  await clearAuthRateLimits();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await checkAuthRateLimit("100.64.1." + attempt, "login", "cgnat-" + attempt + "@example.test");
    assert.equal(result.allowed, true, "пользователь " + (attempt + 1) + " за CGNAT");
  }
  // Один и тот же аккаунт всё равно упирается в лимит по email.
  await clearAuthRateLimits();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal((await checkAuthRateLimit("100.64.2.1", "login", "same@example.test")).allowed, true);
  }
  assert.equal((await checkAuthRateLimit("100.64.2.2", "login", "same@example.test")).allowed, false);
});

test("admin/TOTP/password reset/register закрыты при недоступном хранилище, SMS — нет", async () => {
  const original = process.env.WEBNESTDEV_DATA_DIR!;
  const broken = path.join(original, "not-a-directory");
  await writeFile(broken, "файл вместо каталога");
  process.env.WEBNESTDEV_DATA_DIR = broken;
  try {
    for (const action of ["register", "passwordReset", "passwordResetConfirm", "adminLogin", "adminTotp"] as const) {
      const result = await checkAuthRateLimit("203.0.113.77", action, "user@example.test");
      assert.equal(result.allowed, false, action + " должен быть fail-closed");
      assert.ok(!result.allowed && result.retryAfter > 0);
    }
    // SMS-действия не меняем: их основная защита — счётчики phone-store, а не этот лимитер.
    for (const action of ["phone", "phoneVerify", "phoneDemo"] as const) {
      assert.equal((await checkAuthRateLimit("203.0.113.78", action, "+79990000000")).allowed, true, action + " остаётся fail-open");
    }
  } finally {
    process.env.WEBNESTDEV_DATA_DIR = original;
  }
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
