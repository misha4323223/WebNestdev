import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * VK ID returns the result inside a JSON `payload`, so the test checks the public
 * start (PKCE + state), the short-lived cookie, the code exchange with a mocked VK,
 * the resulting session, account reuse, and that a tampered state never reaches the
 * token endpoint.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-vk-route-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.VK_CLIENT_ID = "test-client";
for (const name of ["VK_SERVICE_TOKEN", "VK_CALLBACK_URL", "VK_FRONTEND_URL", "VK_OAUTH_SCOPE"]) delete process.env[name];

const Fastify = (await import("fastify")).default;
const cookie = (await import("@fastify/cookie")).default;
const { registerAuthRoutes } = await import("./auth.js");
const { registerVkRoutes } = await import("./vk.js");

const origin = "http://localhost:5173";

async function buildApp() {
  const app = Fastify();
  await app.register(cookie);
  await registerAuthRoutes(app);
  await registerVkRoutes(app);
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

function payloadUrl(input: { code: string; state: string; deviceId: string }) {
  const payload = JSON.stringify({ code: input.code, state: input.state, type: "code_v2", device_id: input.deviceId });
  return "/api/auth/vk/callback?payload=" + encodeURIComponent(payload);
}

test("status and start advertise the PKCE callback registered in the VK app", async t => {
  const app = await buildApp();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  const status = await app.inject({ method: "GET", url: "/api/auth/vk/status?origin=" + encodeURIComponent(origin) });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, true);
  assert.equal(status.json().callbackUrl, origin + "/api/auth/vk/callback");
  assert.equal(status.json().loginPath, "/api/auth/vk/start");

  const start = await app.inject({ method: "GET", url: "/api/auth/vk/start?origin=" + encodeURIComponent(origin) });
  assert.equal(start.statusCode, 302);
  const location = new URL(String(start.headers.location));
  assert.equal(location.origin, "https://id.vk.ru");
  assert.equal(location.pathname, "/authorize");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("client_id"), "test-client");
  assert.equal(location.searchParams.get("redirect_uri"), origin + "/api/auth/vk/callback");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok((location.searchParams.get("code_challenge") ?? "").length >= 43);
  const state = location.searchParams.get("state") ?? "";
  assert.ok(state.length >= 32);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  // No scope by default: the app's vkid.personal_info is enough for sign-in.
  assert.equal(location.searchParams.get("scope"), null);
  assert.ok(cookieNamed(start, "webnestdev_vk_login"));
});

test("a valid callback exchanges the code and opens the same VK identity on the next sign-in", async t => {
  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  const tokenBodies: URLSearchParams[] = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.VK_SERVICE_TOKEN;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  process.env.VK_SERVICE_TOKEN = "test-service-token";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (url.endsWith("/oauth2/auth")) {
      tokenBodies.push(body);
      return new Response(JSON.stringify({ access_token: "vk-token", user_id: 42, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/oauth2/user_info")) {
      assert.equal(body.get("client_id"), "test-client");
      assert.equal(body.get("access_token"), "vk-token");
      return new Response(JSON.stringify({ user: { user_id: "42", first_name: "Иван", last_name: "Петров", email: "ivan@example.com" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("unexpected request: " + url);
  }) as typeof fetch;

  async function signIn(usePayload: boolean) {
    const start = await app.inject({ method: "GET", url: "/api/auth/vk/start?origin=" + encodeURIComponent(origin) });
    const location = new URL(String(start.headers.location));
    const state = location.searchParams.get("state") ?? "";
    const cookie = cookieNamed(start, "webnestdev_vk_login") ?? "";
    const url = usePayload
      ? payloadUrl({ code: "one-time-code", state, deviceId: "device-1" })
      : "/api/auth/vk/callback?code=one-time-code&state=" + encodeURIComponent(state) + "&device_id=device-1";
    const callback = await app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, origin + "/?vk_login=ok");
    return { session: cookieNamed(callback, "webnestdev_session"), state };
  }

  const first = await signIn(true);
  assert.ok(first.session, "a session cookie is issued after VK ID sign-in");
  assert.equal(tokenBodies.length, 1);
  assert.equal(tokenBodies[0].get("grant_type"), "authorization_code");
  assert.equal(tokenBodies[0].get("code"), "one-time-code");
  assert.equal(tokenBodies[0].get("device_id"), "device-1");
  assert.equal(tokenBodies[0].get("redirect_uri"), origin + "/api/auth/vk/callback");
  assert.equal(tokenBodies[0].get("state"), first.state);
  assert.equal(tokenBodies[0].get("service_token"), "test-service-token");
  assert.ok((tokenBodies[0].get("code_verifier") ?? "").length >= 43);

  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: first.session! } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().authenticated, true);
  // The local address is synthetic; the VK profile e-mail is identity data and
  // deliberately never merges into an unverified local account.
  assert.equal(me.json().user.email, "vk-42@vk-id.webnestdev.local");
  assert.equal(me.json().user.vk.name, "Иван Петров");
  assert.equal(me.json().user.vk.email, "ivan@example.com");

  // Direct query parameters are accepted too, and a second sign-in opens the same account.
  const again = await signIn(false);
  const meAgain = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: again.session! } });
  assert.equal(meAgain.json().user.id, me.json().user.id);
});

test("a mismatched state is rejected before any token request", async t => {
  const app = await buildApp();
  const originalFetch = globalThis.fetch;
  let called = false;
  t.after(async () => { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); });

  globalThis.fetch = (async () => { called = true; throw new Error("must not be called"); }) as typeof fetch;
  const start = await app.inject({ method: "GET", url: "/api/auth/vk/start?origin=" + encodeURIComponent(origin) });
  const state = new URL(String(start.headers.location)).searchParams.get("state") ?? "";
  const cookie = cookieNamed(start, "webnestdev_vk_login") ?? "";
  const callback = await app.inject({
    method: "GET",
    url: payloadUrl({ code: "one-time-code", state: state + "tampered", deviceId: "device-1" }),
    headers: { cookie },
  });
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, origin + "/?vk_login=state_expired");
  assert.equal(called, false);
});

test("without a client id the button reports not_configured instead of starting", async t => {
  const app = await buildApp();
  const previous = process.env.VK_CLIENT_ID;
  delete process.env.VK_CLIENT_ID;
  t.after(async () => {
    if (previous === undefined) delete process.env.VK_CLIENT_ID;
    else process.env.VK_CLIENT_ID = previous;
    await app.close();
  });

  const status = await app.inject({ method: "GET", url: "/api/auth/vk/status?origin=" + encodeURIComponent(origin) });
  assert.equal(status.json().configured, false);
  const start = await app.inject({ method: "GET", url: "/api/auth/vk/start?origin=" + encodeURIComponent(origin) });
  assert.equal(start.statusCode, 302);
  assert.equal(start.headers.location, origin + "/?vk_login=not_configured");
});
