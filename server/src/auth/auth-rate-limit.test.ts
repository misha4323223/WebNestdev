import test from "node:test";
import assert from "node:assert/strict";
import { checkAuthRateLimit, clearAuthRateLimits } from "./auth-rate-limit.js";

/**
 * Две двери считаются независимо: адрес останавливает веер по аккаунтам, аккаунт — перебор с
 * разных адресов. Раньше был только счётчик адреса, и за прокси он превращался в один общий на
 * всю платформу — это и проверяется здесь по обеим сторонам.
 */
test("перебор одного аккаунта с разных адресов упирается в лимит аккаунта", () => {
  clearAuthRateLimits();
  const email = "victim@example.test";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = checkAuthRateLimit("10.0.0." + (attempt + 1), "login", email);
    assert.equal(result.allowed, true, "попытка " + (attempt + 1) + " должна пройти");
  }
  const blocked = checkAuthRateLimit("10.0.1.1", "login", email);
  assert.equal(blocked.allowed, false);
  assert.ok("retryAfter" in blocked && blocked.retryAfter > 0);

  // Другой аккаунт с того же адреса не заблокирован: счётчики не общие.
  const other = checkAuthRateLimit("10.0.1.1", "login", "other@example.test");
  assert.equal(other.allowed, true);
});

test("веер по многим аккаунтам с одного адреса упирается в лимит адреса", () => {
  clearAuthRateLimits();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = checkAuthRateLimit("10.9.9.9", "login", "user" + attempt + "@example.test");
    assert.equal(result.allowed, true, "попытка " + (attempt + 1) + " должна пройти");
  }
  const blocked = checkAuthRateLimit("10.9.9.9", "login", "new@example.test");
  assert.equal(blocked.allowed, false);
});

test("без email проверяется только адрес, а разные действия не смешиваются", () => {
  clearAuthRateLimits();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal(checkAuthRateLimit("10.5.5.5", "register").allowed, true);
  }
  assert.equal(checkAuthRateLimit("10.5.5.5", "register").allowed, false);
  // Вход с того же адреса — отдельный счётчик, регистрация его не исчерпала.
  assert.equal(checkAuthRateLimit("10.5.5.5", "login", "someone@example.test").allowed, true);
});
