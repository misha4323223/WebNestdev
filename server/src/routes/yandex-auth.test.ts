import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The sign-in flow shares `/api/yandex/callback` with the Yandex Cloud connector, so the
 * test checks the public start, the state cookie, the code exchange against a mocked
 * Yandex, the session cookie, and that `/api/auth/me` reports the linked identity.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-yandex-route-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.YANDEX_CLIENT_ID = "test-client";
process.env.YANDEX_CLIENT_SECRET = "test-secret";
for (const name of ["YANDEX_CALLBACK_URL", "YANDEX_FRONTEND_URL", "YANDEX_OAUTH_SCOPE"]) delete process.env[name];

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { registerYandexRoutes } = await import("./yandex.js");

const origin = "http://localhost:5173";

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app);
  await registerYandexRoutes(app);
  await app.ready();
  return app;
}

function cookiesFrom(response: { headers: Record<string, unknown> }) {
  const raw = response.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((value): value is string => typeof value === "string").map(value => value.split(";")[0]);
}

function cookieNamed(response: { headers: Record<string, unknown> }, name: string) {
  return cookiesFrom(response).find(value => value.startsWith(name + "=")) ?? null;
}

test("status and start advertise the callback registered in the Yandex app", async t => {
  const app = await buildApp();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const status = await app.inject({ method: "GET", url: "/api/auth/yandex/status?origin=" + encodeURIComponent(origin) });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, true);
  assert.equal(status.json().callbackUrl, origin + "/api/yandex/callback");

  const start = await app.inject({ method: "GET", url: "/api/auth/yandex/start?origin=" + encodeURIComponent(origin) });
  assert.equal(start.statusCode, 302);
  const location = new URL(String(start.headers.location));
  assert.equal(location.origin, "https://oauth.yandex.com");
  assert.equal(location.searchParams.get("client_id"), "test-client");
  assert.equal(location.searchParams.get("redirect_uri"), origin + "/api/yandex/callback");
  assert.ok(location.searchParams.get("state"));
  assert.ok(cookieNamed(start, "webnestdev_yandex_login"));
});

test("a valid callback creates a session and the same Yandex identity on the next sign-in", async t => {
  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/token")) return new Response(JSON.stringify({ access_token: "yandex-token" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("login.yandex.ru")) return new Response(JSON.stringify({ id: "42", login: "alice", default_email: "alice@example.com" }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("unexpected request: " + url);
  }) as typeof fetch;

  async function signIn() {
    const start = await app.inject({ method: "GET", url: "/api/auth/yandex/start?origin=" + encodeURIComponent(origin) });
    const state = new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    const loginCookie = cookieNamed(start, "webnestdev_yandex_login") ?? "";
    const callback = await app.inject({
      method: "GET",
      url: "/api/yandex/callback?state=" + encodeURIComponent(state) + "&code=one-time-code",
      headers: { cookie: loginCookie },
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, origin + "/?yandex_login=ok");
    return cookieNamed(callback, "webnestdev_session");
  }

  const session = await signIn();
  assert.ok(session, "a session cookie is issued after Yandex ID sign-in");
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: session! } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().authenticated, true);
  // The local address is synthetic on purpose; the Yandex e-mail is separate and only
  // shown as identity data, never used to merge with an unverified local account.
  assert.equal(me.json().user.email, "yandex-42@yandex-id.webnestdev.local");
  assert.equal(me.json().user.yandex.login, "alice");
  assert.equal(me.json().user.yandex.email, "alice@example.com");

  // A second visit to the consent screen opens the same local account.
  const again = await signIn();
  const meAgain = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: again! } });
  assert.equal(meAgain.json().user.id, me.json().user.id);
});

test("a mismatched state is rejected before any token request", async t => {
  const app = await buildApp();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const start = await app.inject({ method: "GET", url: "/api/auth/yandex/start?origin=" + encodeURIComponent(origin) });
  const state = new URL(String(start.headers.location)).searchParams.get("state") ?? "";
  const loginCookie = cookieNamed(start, "webnestdev_yandex_login") ?? "";
  const callback = await app.inject({
    method: "GET",
    url: "/api/yandex/callback?state=" + encodeURIComponent(state + "tampered") + "&code=one-time-code",
    headers: { cookie: loginCookie },
  });
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, origin + "/?yandex_login=state_expired");
});

test("without app credentials the button redirects with a readable reason", async t => {
  delete process.env.YANDEX_CLIENT_ID;
  delete process.env.YANDEX_CLIENT_SECRET;
  t.after(() => {
    process.env.YANDEX_CLIENT_ID = "test-client";
    process.env.YANDEX_CLIENT_SECRET = "test-secret";
  });
  const app = await buildApp();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const status = await app.inject({ method: "GET", url: "/api/auth/yandex/status?origin=" + encodeURIComponent(origin) });
  assert.equal(status.json().configured, false);

  const start = await app.inject({ method: "GET", url: "/api/auth/yandex/start?origin=" + encodeURIComponent(origin) });
  assert.equal(start.statusCode, 302);
  assert.equal(start.headers.location, origin + "/?yandex_login=not_configured");
});
