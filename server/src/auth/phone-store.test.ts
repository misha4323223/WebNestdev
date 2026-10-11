import test from "node:test";
import assert from "node:assert/strict";
import { clearPendingCodes, formatPhone, normalizePhone, startPhoneLogin, verifyPhoneCode } from "./phone-store.js";

test("Russian numbers are normalized however the user types them", () => {
  assert.equal(normalizePhone("+7 999 123-45-67"), "+79991234567");
  assert.equal(normalizePhone("8 (999) 123 45 67"), "+79991234567");
  assert.equal(normalizePhone("9991234567"), "+79991234567");
  assert.equal(normalizePhone("79991234567"), "+79991234567");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone("+1 415 555 0132"), null);
  assert.equal(normalizePhone(""), null);
});

test("a number is formatted for display", () => {
  assert.equal(formatPhone("+79991234567"), "+7 999 123-45-67");
});

test("a code is six digits and a resend is rate limited", () => {
  clearPendingCodes();
  const phone = "+79990000001";
  const start = 1_000_000;
  const first = startPhoneLogin(phone, start);
  assert.equal(first.ok, true);
  assert.match(first.ok ? first.code : "", /^\d{6}$/);

  const tooSoon = startPhoneLogin(phone, start + 1_000);
  assert.equal(tooSoon.ok, false);
  assert.match(tooSoon.ok ? "" : tooSoon.error, /уже отправлен/);

  const second = startPhoneLogin(phone, start + 60_000);
  const third = startPhoneLogin(phone, start + 120_000);
  const fourth = startPhoneLogin(phone, start + 180_000);
  assert.equal(second.ok && third.ok && fourth.ok, true);

  const tooMany = startPhoneLogin(phone, start + 240_000);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.ok ? "" : tooMany.error, /Слишком много кодов/);
});

test("only the last code works and a used code cannot be replayed", () => {
  clearPendingCodes();
  const phone = "+79990000002";
  const start = 2_000_000;
  const first = startPhoneLogin(phone, start);
  const second = startPhoneLogin(phone, start + 60_000);
  assert.equal(first.ok && second.ok, true);
  const code = second.ok ? second.code : "";
  const stale = first.ok ? first.code : "";
  const wrong = code === "000000" ? "111111" : "000000";

  assert.equal(verifyPhoneCode(phone, wrong, start + 61_000).ok, false);
  if (stale !== code) assert.equal(verifyPhoneCode(phone, stale, start + 61_000).ok, false);
  assert.equal(verifyPhoneCode(phone, code, start + 62_000).ok, true);
  const replay = verifyPhoneCode(phone, code, start + 63_000);
  assert.equal(replay.ok, false);
  assert.match(replay.ok ? "" : replay.error, /новый код/);
});

test("an expired code is refused", () => {
  clearPendingCodes();
  const phone = "+79990000003";
  const start = 3_000_000;
  const started = startPhoneLogin(phone, start);
  assert.equal(started.ok, true);
  const result = verifyPhoneCode(phone, started.ok ? started.code : "", start + 6 * 60 * 1000);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /истёк/);
});

test("repeated wrong guesses invalidate the code", () => {
  clearPendingCodes();
  const phone = "+79990000004";
  const start = 4_000_000;
  const started = startPhoneLogin(phone, start);
  const code = started.ok ? started.code : "";
  const wrong = code === "000000" ? "111111" : "000000";
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(verifyPhoneCode(phone, wrong, start + 1_000 + attempt).ok, false);
  }
  const blocked = verifyPhoneCode(phone, code, start + 2_000);
  assert.equal(blocked.ok, false);
});
