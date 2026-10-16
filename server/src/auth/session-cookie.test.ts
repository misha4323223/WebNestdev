import test from "node:test";
import assert from "node:assert/strict";
import { sessionCookieSecure } from "./auth.js";

type Request = Parameters<typeof sessionCookieSecure>[0];

/** Запрос с нужными заголовками и схемой соединения — больше функции ничего не нужно. */
function request(headers: Record<string, string> = {}, protocol = "http") {
  return { headers, protocol } as unknown as Request;
}

function withConfigured(value: string | undefined, body: () => void) {
  const before = process.env.WEBNESTDEV_COOKIE_SECURE;
  if (value === undefined) delete process.env.WEBNESTDEV_COOKIE_SECURE;
  else process.env.WEBNESTDEV_COOKIE_SECURE = value;
  try {
    body();
  } finally {
    if (before === undefined) delete process.env.WEBNESTDEV_COOKIE_SECURE;
    else process.env.WEBNESTDEV_COOKIE_SECURE = before;
  }
}

test("cookie без Secure на http: иначе браузер её выбрасывает и вход не запоминается", () => {
  withConfigured(undefined, () => {
    assert.equal(sessionCookieSecure(request()), false);
    // Запрос без объекта запроса тоже не должен включать Secure.
    assert.equal(sessionCookieSecure(undefined), false);
  });
});

test("cookie с Secure, когда соединение действительно по https", () => {
  withConfigured(undefined, () => {
    assert.equal(sessionCookieSecure(request({}, "https")), true);
    // Так схему сообщает TLS-прокси; список может содержать несколько значений.
    assert.equal(sessionCookieSecure(request({ "x-forwarded-proto": "https" })), true);
    assert.equal(sessionCookieSecure(request({ "x-forwarded-proto": "HTTPS" })), true);
    assert.equal(sessionCookieSecure(request({ "x-forwarded-proto": "https, http" })), true);
    assert.equal(sessionCookieSecure(request({ "x-forwarded-proto": "http" })), false);
    // Заголовок решает и тогда, когда сокет внутри уже без шифрования.
    assert.equal(sessionCookieSecure(request({ "x-forwarded-proto": "http" }, "https")), false);
  });
});

test("WEBNESTDEV_COOKIE_SECURE переопределяет схему в обе стороны", () => {
  withConfigured("true", () => {
    assert.equal(sessionCookieSecure(request()), true);
  });
  withConfigured("false", () => {
    assert.equal(sessionCookieSecure(request({ "x-forwarded-proto": "https" })), false);
  });
});
