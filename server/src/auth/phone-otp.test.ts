import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRussianPhone } from "./phone-otp.js";

test("normalizes Russian phone numbers to one canonical +7 representation", () => {
  assert.equal(normalizeRussianPhone("+7 900 123-45-67"), "+79001234567");
  assert.equal(normalizeRussianPhone("8 (900) 123-45-67"), "+79001234567");
  assert.equal(normalizeRussianPhone("9001234567"), "+79001234567");
  assert.equal(normalizeRussianPhone("7 900 123 45 67"), "+79001234567");
});

test("rejects numbers outside the supported Russian mobile format", () => {
  assert.equal(normalizeRussianPhone("+1 202 555 0123"), null);
  assert.equal(normalizeRussianPhone("+7 900 123"), null);
  assert.equal(normalizeRussianPhone("not a phone"), null);
});
