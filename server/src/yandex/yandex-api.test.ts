import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { getIamTokenFor, parseServiceAccountKey } from "./yandex-api.js";

const { privateKey } = generateKeyPairSync("ed25519");
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const KEY = { id: "aje1testkey", service_account_id: "aje2testaccount", private_key: PEM };

test("an authorized key written as one line parses as is", () => {
  const parsed = parseServiceAccountKey(JSON.stringify(KEY));
  assert.equal(parsed.id, KEY.id);
  assert.equal(parsed.service_account_id, KEY.service_account_id);
  assert.equal(parsed.private_key, PEM);
});

test("quotes a `.env` writer added around the value are stripped", () => {
  const parsed = parseServiceAccountKey(JSON.stringify(JSON.stringify(KEY)));
  assert.equal(parsed.id, KEY.id);
  assert.equal(parsed.private_key, PEM);
});

test("a pretty-printed paste with real line breaks in private_key still parses", () => {
  // JSON.stringify escapes the PEM line breaks; replacing them with real newlines is
  // what a paste through an editor or a one-line environment field produces.
  const withRealLineBreaks = JSON.stringify(KEY, null, 2).replace(/\\n/g, "\n");
  assert.throws(() => JSON.parse(withRealLineBreaks), "the fixture must be invalid JSON on its own");
  const parsed = parseServiceAccountKey(withRealLineBreaks);
  assert.equal(parsed.id, KEY.id);
  assert.equal(parsed.private_key, PEM);
});

test("a value cut off at the first line says so instead of repeating the format", () => {
  assert.throws(() => parseServiceAccountKey('{"id": "aje1testkey"'), /обрезалась/);
  assert.throws(() => parseServiceAccountKey("   "), /authorized key/);
});

test("проверка ключа не переиспользует IAM-токен другого probe-подключения", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = JSON.stringify({
    id: "aje1testkey",
    service_account_id: "aje2testaccount",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
  const probe = {
    userId: "probe",
    id: "probe",
    kind: "key" as const,
    secret: key,
    allowWrites: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ iamToken: "t1.test", expiresAt: new Date(Date.now() + 60_000).toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await getIamTokenFor(probe, { cache: false });
    await getIamTokenFor(probe, { cache: false });
    assert.equal(calls, 2, "каждая проверка ключа должна обменять свой ключ на токен");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
