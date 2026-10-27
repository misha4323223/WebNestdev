import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { attachSession, requireUser, sessionCookieSecure } from "../auth/auth.js";
import { ensureYandexAccount } from "../auth/yandex-account-store.js";
import { exchangeYandexCode, fetchYandexProfile } from "../auth/yandex-login.js";
import { createOAuthState, consumeOAuthState, originFromOAuthState } from "../github/github-oauth-state.js";
import { getYandexConnection, saveYandexConnection, deleteYandexConnection } from "../yandex/yandex-connection-store.js";
import { fetchYandexLogin, saveVerifiedYandexCredential, yandexStatus } from "../yandex/yandex-api.js";
import { yandexOAuthConfig } from "../yandex/yandex-oauth-config.js";
import { resolveOAuthFlow, redirectToApp, type OAuthFlowOptions } from "../oauth/oauth-flow.js";

/**
 * The same Yandex ID app is used for two different things:
 * - sign-in (identity): a public flow that opens the app's account;
 * - the Cloud connector (access): an authenticated flow that stores a credential.
 * They share the callback URL already registered in the app, so enabling sign-in does
 * not require editing the Yandex app. The login flow is recognised by its own
 * short-lived cookie; the connector keeps its server-side state.
 */
export { yandexOAuthConfig };

const LOGIN_COOKIE = "webnestdev_yandex_login";
const LOGIN_STATE_TTL_SECONDS = 10 * 60;

function resolveFlow(request: Parameters<typeof resolveOAuthFlow>[0], requestedOrigin?: string) {
  const { configuredCallbackUrl, configuredFrontendUrl } = yandexOAuthConfig();
  const options: OAuthFlowOptions = { callbackPath: "/api/yandex/callback", configuredCallbackUrl, configuredFrontendUrl, requestedOrigin };
  return resolveOAuthFlow(request, options);
}

function redirect(reply: { redirect: (url: string) => unknown }, frontendUrl: string, status: string, param = "yandex") {
  return redirectToApp(reply, frontendUrl, param, status);
}

/** A random state with the origin after the dot, the same shape the connector uses. */
function createLoginState(origin: string) {
  return randomBytes(32).toString("hex") + "." + Buffer.from(origin, "utf8").toString("base64url");
}

function clearLoginState(reply: { clearCookie: (name: string, options?: Record<string, unknown>) => unknown }) {
  return reply.clearCookie(LOGIN_COOKIE, { path: "/" });
}

export async function registerYandexRoutes(app: FastifyInstance) {
  /** Public: the sign-in screen asks whether the Yandex button can work. */
  app.get("/api/auth/yandex/status", async request => {
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const { clientId, clientSecret } = yandexOAuthConfig();
    return {
      configured: Boolean(clientId && clientSecret),
      callbackUrl: flow.callbackUrl,
      loginPath: "/api/auth/yandex/start",
    };
  });

  /**
   * Sign in with Yandex ID. This is public on purpose: the visitor has no session yet.
   * No scope is sent, so the app's own permissions decide what the profile contains;
   * login:info is enough for the id and login, login:email additionally gives e-mail.
   */
  app.get("/api/auth/yandex/start", async (request, reply) => {
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const { clientId, clientSecret } = yandexOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured", "yandex_login");

    const state = createLoginState(flow.origin);
    reply.setCookie(LOGIN_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieSecure(request),
      path: "/",
      maxAge: LOGIN_STATE_TTL_SECONDS,
    });

    const url = new URL("https://oauth.yandex.com/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", flow.callbackUrl);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/api/yandex/status", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const status = await yandexStatus(user.id);
    const { clientId, clientSecret, scope } = yandexOAuthConfig();
    return { ...status, configured: Boolean(clientId && clientSecret), callbackUrl: flow.callbackUrl, scope };
  });

  /** The key/token form: verified against Yandex Cloud before it is stored. */
  app.post("/api/yandex/secret", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ secret: z.string().min(20).max(8000), allowWrites: z.boolean().optional() }).parse(request.body);
    const existing = await getYandexConnection(user.id);
    try {
      return await saveVerifiedYandexCredential(user.id, body.secret, body.allowWrites ?? existing?.allowWrites ?? false);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось проверить ключ" });
    }
  });

  /** Writes are the user's decision, so creating and deleting resources is opt-in. */
  app.post("/api/yandex/writes", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ allowWrites: z.boolean() }).parse(request.body);
    const connection = await getYandexConnection(user.id);
    if (!connection) return reply.code(400).send({ error: "Yandex Cloud не подключён" });
    await saveYandexConnection({ ...connection, allowWrites: body.allowWrites, updatedAt: new Date().toISOString() });
    return yandexStatus(user.id);
  });

  app.post("/api/yandex/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    await deleteYandexConnection(user.id);
    return { connected: false };
  });

  app.get("/api/yandex/connect", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const { clientId, clientSecret, scope } = yandexOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured");
    // A stale login state must not make the connector callback look like a sign-in.
    clearLoginState(reply);
    const state = await createOAuthState(user.id, flow.origin);
    const url = new URL("https://oauth.yandex.com/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", flow.callbackUrl);
    // Без scope Яндекс выдаёт токен с правами, отмеченными в приложении: так подключение
    // работает и с набором, отличным от cloud-api.
    if (scope) url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/api/yandex/callback", async (request, reply) => {
    const query = z.object({
      state: z.string().min(1),
      code: z.string().min(1).optional(),
      error: z.string().optional(),
    }).parse(request.query);

    // Sign-in first: an unauthenticated visitor has the login cookie and no session.
    const loginState = request.cookies?.[LOGIN_COOKIE];
    if (loginState) {
      // The cookie was written by us, so its origin is trusted even when the state in
      // the query was tampered with; redirecting there also keeps the app on the host
      // that started the flow instead of an API-host fallback.
      const flow = resolveFlow(request, originFromOAuthState(loginState) ?? undefined);
      clearLoginState(reply);
      if (loginState !== query.state) return redirect(reply, flow.frontendUrl, "state_expired", "yandex_login");
      if (query.error) return redirect(reply, flow.frontendUrl, "denied", "yandex_login");
      if (!query.code) return redirect(reply, flow.frontendUrl, "error", "yandex_login");
      const { clientId, clientSecret } = yandexOAuthConfig();
      if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured", "yandex_login");

      try {
        const accessToken = await exchangeYandexCode(query.code, clientId, clientSecret);
        const profile = await fetchYandexProfile(accessToken);
        const user = await ensureYandexAccount(profile);
        if (!(await attachSession(reply, user.id, request))) return redirect(reply, flow.frontendUrl, "blocked", "yandex_login");
        return redirect(reply, flow.frontendUrl, "ok", "yandex_login");
      } catch (error) {
        request.log.warn({ error: error instanceof Error ? error.message : error }, "yandex id sign-in failed");
        return redirect(reply, flow.frontendUrl, "profile_error", "yandex_login");
      }
    }

    // The connector: an already signed-in user links Yandex Cloud.
    const user = await requireUser(request, reply); if (!user) return;
    const flow = resolveFlow(request, originFromOAuthState(query.state) ?? undefined);
    if (query.error) return redirect(reply, flow.frontendUrl, "denied");
    if (!query.code) return redirect(reply, flow.frontendUrl, "error");
    const { clientId, clientSecret } = yandexOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured");
    const oauthUserId = await consumeOAuthState(query.state);
    if (!oauthUserId || oauthUserId !== user.id) return redirect(reply, flow.frontendUrl, "state_expired");

    const response = await fetch("https://oauth.yandex.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const token = await response.json() as { access_token?: string; error_description?: string };
    if (!token.access_token) return redirect(reply, flow.frontendUrl, "token_error");

    const login = await fetchYandexLogin(token.access_token);
    const existing = await getYandexConnection(user.id);
    try {
      await saveVerifiedYandexCredential(user.id, token.access_token, existing?.allowWrites ?? false, login);
    } catch {
      // The token is valid for Yandex, but Yandex Cloud may refuse it: roles live in IAM
      // and new Yandex ID OAuth tokens are no longer accepted there.
      return redirect(reply, flow.frontendUrl, "cloud_error");
    }
    return redirect(reply, flow.frontendUrl, "connected");
  });
}
