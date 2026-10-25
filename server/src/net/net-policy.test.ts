import test from "node:test";
import assert from "node:assert/strict";
import {
  approvalQuestion,
  assertHeaderSafeSecret,
  findSecretValue,
  publicResponseHeaders,
  redactSecret,
  sanitizeHeaders,
} from "./net-policy.js";

test("authorization and cookie headers cannot be set by the model", () => {
  for (const name of ["Authorization", "cookie", "Host", "Content-Length"]) {
    assert.throws(() => sanitizeHeaders({ [name]: "x" }), /нельзя задать вручную|Некорректное/);
  }
  assert.deepEqual(sanitizeHeaders({ "X-Api-Key": "abc" }), { "x-api-key": "abc" });
});

test("headers with a line break are refused", () => {
  assert.throws(() => sanitizeHeaders({ "x-test": "a\r\nInjected: 1" }), /переводы строк/);
});

test("a multi-line key is refused before the request instead of failing in the transport", () => {
  assert.throws(() => assertHeaderSafeSecret("-----BEGIN KEY-----\nabc\n-----END KEY-----"), /перевод строки/);
  assert.throws(() => assertHeaderSafeSecret("   "), /пустое/);
  assert.doesNotThrow(() => assertHeaderSafeSecret("sk_live_123"));
});

test("the secret is found in the named file or in the first file that has it", () => {
  const files = {
    ".env.local": { STRIPE_KEY: "sk_live_1" },
    ".env.production": { STRIPE_KEY: "sk_live_2", OTHER: "x" },
  };
  assert.deepEqual(findSecretValue(files, "STRIPE_KEY"), { value: "sk_live_1", file: ".env.local" });
  assert.deepEqual(findSecretValue(files, "STRIPE_KEY", ".env.production"), { value: "sk_live_2", file: ".env.production" });
  assert.equal(findSecretValue(files, "STRIPE_KEY", ".env"), null);
  assert.equal(findSecretValue(files, "MISSING"), null);
});

test("the approval question names the variable and the exact destination", () => {
  const question = approvalQuestion({
    variable: "STRIPE_SECRET_KEY",
    file: ".env.local",
    method: "post",
    url: new URL("https://api.stripe.com/v1/charges"),
  });
  assert.match(question, /STRIPE_SECRET_KEY/);
  assert.match(question, /api\.stripe\.com\/v1\/charges/);
  assert.match(question, /POST/);
  assert.ok(question.length <= 400, "вопрос должен помещаться в окно панели");
});

test("the key is cut out of the response, short values are left alone", () => {
  assert.equal(redactSecret("token sk_live_123 accepted", "sk_live_123"), "token [ключ скрыт] accepted");
  assert.equal(redactSecret("nothing here", "abc"), "nothing here");
  assert.equal(redactSecret("nothing here"), "nothing here");
});

test("response headers are narrowed to what a caller needs", () => {
  assert.deepEqual(
    publicResponseHeaders({
      "content-type": "application/json",
      "set-cookie": "session=1",
      server: "nginx",
      "retry-after": "30",
      "x-ratelimit-remaining": ["9", "9"],
    }),
    { "content-type": "application/json", "retry-after": "30", "x-ratelimit-remaining": "9, 9" },
  );
});
