import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORT_API_KEY_ENV, supportApiKey, supportKeyAuthorized, supportKeyFromHeaders, supportKeyMatches } from "./support-api-key.js";

const KEY = "read-only-key-0123456789";

function withKey(value: string | undefined, run: () => void) {
  const previous = process.env[SUPPORT_API_KEY_ENV];
  if (value === undefined) delete process.env[SUPPORT_API_KEY_ENV];
  else process.env[SUPPORT_API_KEY_ENV] = value;
  try { run(); }
  finally {
    if (previous === undefined) delete process.env[SUPPORT_API_KEY_ENV];
    else process.env[SUPPORT_API_KEY_ENV] = previous;
  }
}

test("the key is accepted from a bearer header or from x-support-key", () => {
  assert.equal(supportKeyFromHeaders({ authorization: "Bearer " + KEY }), KEY);
  assert.equal(supportKeyFromHeaders({ authorization: "bearer   " + KEY + "  " }), KEY);
  assert.equal(supportKeyFromHeaders({ "x-support-key": KEY }), KEY);
  assert.equal(supportKeyFromHeaders({ "x-support-key": [KEY] }), KEY);
  // Другой способ авторизации ключом не считается: cookie сессии сюда не подставляется.
  assert.equal(supportKeyFromHeaders({ authorization: "Basic " + KEY }), null);
  assert.equal(supportKeyFromHeaders({}), null);
});

test("only a matching key is authorised, and a short key is not a key at all", () => {
  withKey(KEY, () => {
    assert.equal(supportApiKey(), KEY);
    assert.ok(supportKeyAuthorized({ authorization: "Bearer " + KEY }));
    assert.equal(supportKeyAuthorized({ authorization: "Bearer " + KEY + "x" }), false);
    assert.equal(supportKeyAuthorized({}), false);
  });
  // 15 символов — ещё не ключ: такой подбирается перебором, а панель отдаёт все обращения.
  withKey(KEY.slice(0, 15), () => {
    assert.equal(supportApiKey(), null);
    assert.equal(supportKeyAuthorized({ "x-support-key": KEY.slice(0, 15) }), false);
  });
  withKey(undefined, () => {
    assert.equal(supportApiKey(), null);
    assert.equal(supportKeyAuthorized({ authorization: "Bearer " + KEY }), false);
  });
});

test("keys of different lengths still compare without leaking the length", () => {
  assert.equal(supportKeyMatches("short", "a-much-longer-expected-key"), false);
  assert.equal(supportKeyMatches("same-value", "same-value"), true);
  assert.equal(supportKeyMatches(null, "same-value"), false);
  assert.equal(supportKeyMatches("same-value", null), false);
});

test("перенос строки и невидимые символы в ключе не ломают сравнение", () => {
  // Так выглядит ключ, скопированный из документа: zero-width разделитель посреди строки.
  withKey("read-only-key-\u200B0123456789", () => {
    assert.equal(supportApiKey(), "read-only-key-0123456789");
    assert.ok(supportKeyAuthorized({ authorization: "Bearer read-only-key-0123456789" }));
    // Клиент тоже может прислать ключ с переносом — для заголовка это не часть значения.
    assert.ok(supportKeyAuthorized({ "x-support-key": "read-only-key-\n0123456789" }));
  });
});
