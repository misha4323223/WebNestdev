import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { parseServiceAccountKey } from "./yandex-api.js";

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
