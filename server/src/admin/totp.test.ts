import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  matchTotp,
  normalizeRecoveryCode,
  otpauthUri,
  totp,
  totpStep,
} from "./totp.js";

/** Секрет из RFC 6238, приложение B: ASCII "12345678901234567890" в base32. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("TOTP совпадает с официальными векторами RFC 6238 (SHA-1, 8 цифр)", () => {
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp(RFC_SECRET, seconds * 1000, 8), expected, "код на " + seconds + " с");
  }
});

test("шестизначный код — это тот же HOTP, а не другая формула", () => {
  assert.equal(totp(RFC_SECRET, 59_000, 6), "287082");
});

test("base32: секрет возвращается без потерь, пробелы и дефисы допустимы", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const bytes = base32Decode(secret);
  assert.equal(bytes.length, 20);
  assert.equal(base32Encode(bytes), secret);
  const grouped = secret.slice(0, 4) + " " + secret.slice(4, 8) + "-" + secret.slice(8);
  assert.deepEqual(base32Decode(grouped), bytes);
});

test("base32: посторонний символ — ошибка, а не тихо другой секрет", () => {
  assert.throws(() => base32Decode("ABCD1EFG"), /base32/);
  assert.throws(() => base32Decode("   "), /Пустой секрет/);
});

test("код принимается с допуском в один шаг и не принимается за его пределами", () => {
  const now = 1_700_000_000_000;
  const code = totp(RFC_SECRET, now);
  const step = totpStep(now);
  assert.deepEqual(matchTotp(RFC_SECRET, code, { atMs: now }), { step });
  assert.deepEqual(matchTotp(RFC_SECRET, code, { atMs: now + 30_000 }), { step });
  assert.deepEqual(matchTotp(RFC_SECRET, code, { atMs: now - 30_000 }), { step });
  assert.equal(matchTotp(RFC_SECRET, code, { atMs: now + 90_000 }), null);
  assert.equal(matchTotp(RFC_SECRET, code, { atMs: now - 90_000 }), null);
});

test("уже принятый код второй раз не проходит: окно шага не даёт войти повторно", () => {
  const now = 1_700_000_000_000;
  const code = totp(RFC_SECRET, now);
  const first = matchTotp(RFC_SECRET, code, { atMs: now });
  assert.ok(first);
  assert.equal(matchTotp(RFC_SECRET, code, { atMs: now, afterStep: first.step }), null);
});

test("код другого секрета и мусор вместо кода отвергаются", () => {
  const now = 1_700_000_000_000;
  const other = generateTotpSecret();
  assert.equal(matchTotp(other, totp(RFC_SECRET, now), { atMs: now }), null);
  assert.equal(matchTotp(RFC_SECRET, "abcdef", { atMs: now }), null);
  assert.equal(matchTotp(RFC_SECRET, "", { atMs: now }), null);
  assert.equal(matchTotp("НЕ-BASE32", totp(RFC_SECRET, now), { atMs: now }), null);
});

test("ссылка otpauth несёт секрет, издателя и параметры, которые понимает аутентификатор", () => {
  const uri = otpauthUri({ issuer: "NestDev", account: "admin@example.test", secret: RFC_SECRET });
  assert.ok(uri.startsWith("otpauth://totp/NestDev:admin%40example.test?"));
  const params = new URLSearchParams(uri.slice(uri.indexOf("?") + 1));
  assert.equal(params.get("secret"), RFC_SECRET);
  assert.equal(params.get("issuer"), "NestDev");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
  assert.equal(params.get("algorithm"), "SHA1");
});

test("коды восстановления: их десять, они разные и подходят ровно один раз", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);

  const hashes = codes.map(hashRecoveryCode);
  // Дефис и регистр не решают, подойдёт ли код: человек переписывает его как удобно.
  assert.equal(matchRecoveryCode(hashes, codes[3].toLowerCase().replace("-", " ")), 3);
  assert.equal(matchRecoveryCode(hashes, "AAAAA-AAAAA"), -1);
  assert.equal(normalizeRecoveryCode(" ab-cd "), "ABCD");
});
