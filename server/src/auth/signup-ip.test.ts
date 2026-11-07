import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Предел аккаунтов на адрес проверяется на настоящем файловом хранилище: правило «навсегда, а не
 * на сутки» — это про то, что счётчик не исчезает со временем, и проверять его надо там же, где
 * он живёт. Данные — во временном каталоге, база не нужна.
 */
const dataDir = await mkdtemp(path.join(os.tmpdir(), "nestdev-signup-ip-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_STORAGE;
delete process.env.DATABASE_URL;
delete process.env.SIGNUP_IP_LIMIT;

const {
  reserveSignupIp,
  releaseSignupIp,
  resetSignupIp,
  signupIpAccounts,
  signupIpExceededMessage,
  normalizeSignupIp,
  DEFAULT_SIGNUP_IP_LIMIT,
} = await import("./signup-ip.js");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("четвёртый аккаунт с адреса не проходит, первые три проходят", async () => {
  const ip = "203.0.113.7";
  for (let index = 1; index <= DEFAULT_SIGNUP_IP_LIMIT; index += 1) {
    const verdict = await reserveSignupIp(ip);
    assert.equal(verdict.allowed, true, "аккаунт " + index + " должен проходить");
    assert.equal(verdict.used, index);
  }
  const blocked = await reserveSignupIp(ip);
  if (blocked.allowed) throw new Error("четвёртый аккаунт с одного адреса не должен проходить");
  assert.equal(blocked.limit, DEFAULT_SIGNUP_IP_LIMIT);
  assert.equal(await signupIpAccounts(ip), DEFAULT_SIGNUP_IP_LIMIT, "отказ не накручивает счётчик");
});

test("адреса считаются отдельно друг от друга", async () => {
  for (let index = 0; index < DEFAULT_SIGNUP_IP_LIMIT; index += 1) await reserveSignupIp("198.51.100.1");
  const other = await reserveSignupIp("198.51.100.2");
  assert.equal(other.allowed, true);
  assert.equal(other.used, 1);
});

test("неудачная регистрация возвращает место", async () => {
  const ip = "198.51.100.50";
  for (let index = 0; index < DEFAULT_SIGNUP_IP_LIMIT; index += 1) await reserveSignupIp(ip);
  assert.equal((await reserveSignupIp(ip)).allowed, false);

  await releaseSignupIp(ip);
  assert.equal(await signupIpAccounts(ip), DEFAULT_SIGNUP_IP_LIMIT - 1);
  const retry = await reserveSignupIp(ip);
  assert.equal(retry.allowed, true, "после освобождения место снова доступно");
});

test("повторное освобождение не уводит счётчик в минус", async () => {
  const ip = "198.51.100.60";
  await reserveSignupIp(ip);
  await releaseSignupIp(ip);
  await releaseSignupIp(ip);
  assert.equal(await signupIpAccounts(ip), 0);
});

test("ручной сброс снимает предел: так поддержка разбирает ложное срабатывание", async () => {
  const ip = "198.51.100.70";
  for (let index = 0; index < DEFAULT_SIGNUP_IP_LIMIT; index += 1) await reserveSignupIp(ip);
  await resetSignupIp(ip);
  assert.equal(await signupIpAccounts(ip), 0);
  assert.equal((await reserveSignupIp(ip)).allowed, true);
});

test("SIGNUP_IP_LIMIT меняет предел, 0 снимает ограничение", async () => {
  try {
    process.env.SIGNUP_IP_LIMIT = "1";
    assert.equal((await reserveSignupIp("192.0.2.10")).allowed, true);
    assert.equal((await reserveSignupIp("192.0.2.10")).allowed, false);

    process.env.SIGNUP_IP_LIMIT = "0";
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await reserveSignupIp("192.0.2.10")).allowed, true);
    }
  } finally {
    delete process.env.SIGNUP_IP_LIMIT;
  }
});

test("текст отказа называет предел и путь в поддержку", () => {
  const message = signupIpExceededMessage(DEFAULT_SIGNUP_IP_LIMIT);
  assert.match(message, /создано 3 аккаунта/);
  assert.match(message, /поддержку/);
});

test("пустой адрес не смешивается с настоящими", () => {
  assert.equal(normalizeSignupIp(undefined), "unknown");
  assert.equal(normalizeSignupIp("  "), "unknown");
  assert.equal(normalizeSignupIp(" 203.0.113.7 "), "203.0.113.7");
});
