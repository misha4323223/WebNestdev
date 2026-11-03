import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { attachSession, sessionCookieSecure } from "../auth/auth.js";
import { ensureVkAccount } from "../auth/vk-account-store.js";
import { createVkPkce, createVkState, exchangeVkCode, fetchVkProfile, vkAuthorizeUrl } from "../auth/vk-login.js";
import { vkOAuthConfig } from "../auth/vk-oauth-config.js";
import { resolveOAuthFlow, redirectToApp, type OAuthFlowOptions } from "../oauth/oauth-flow.js";

/**
 * Sign in with VK ID. VK uses Authorization Code + PKCE on its own id.vk.ru
 * endpoints, and no classic client secret: a public client proves possession of
 * the code_verifier, a confidential one additionally sends VK_SERVICE_TOKEN.
 *
 * The short-lived cookie keeps the state, the verifier and the origin that started
 * the flow. The token is used once to read the profile and is never stored.
 */
const LOGIN_COOKIE = "webnestdev_vk_login";
const LOGIN_STATE_TTL_SECONDS = 10 * 60;

type VkLoginState = { state: string; verifier: string; origin: string };

function resolveFlow(request: Parameters<typeof resolveOAuthFlow>[0], requestedOrigin?: string) {
  const { configuredCallbackUrl, configuredFrontendUrl } = vkOAuthConfig();
  const options: OAuthFlowOptions = { callbackPath: "/api/auth/vk/callback", configuredCallbackUrl, configuredFrontendUrl, requestedOrigin };
  return resolveOAuthFlow(request, options);
}

function redirect(reply: { redirect: (url: string) => unknown }, frontendUrl: string, status: string) {
  return redirectToApp(reply, frontendUrl, "vk_login", status);
}

function encodeLoginState(value: VkLoginState) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeLoginState(raw: string | undefined): VkLoginState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<VkLoginState>;
    if (typeof value.state !== "string" || typeof value.verifier !== "string" || typeof value.origin !== "string") return null;
    return { state: value.state, verifier: value.verifier, origin: value.origin };
  } catch {
    return null;
  }
}

const callbackQuery = z.object({
  payload: z.string().max(8000).optional(),
  code: z.string().max(2000).optional(),
  state: z.string().max(2000).optional(),
  device_id: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

type CallbackParams = { code?: string; state?: string; device_id?: string; error?: string; error_description?: string };

/** VK returns the result inside a JSON `payload`; direct query parameters are accepted too. */
function callbackParams(query: z.infer<typeof callbackQuery>): CallbackParams | null {
  const direct: CallbackParams = {
    code: query.code,
    state: query.state,
    device_id: query.device_id,
    error: query.error,
    error_description: query.error_description,
  };
  if (!query.payload) return direct;
  try {
    const payload = JSON.parse(query.payload) as Record<string, unknown>;
    const value = (name: string) => typeof payload[name] === "string" ? payload[name] as string : undefined;
    return {
      code: value("code") ?? direct.code,
      state: value("state") ?? direct.state,
      device_id: value("device_id") ?? direct.device_id,
      error: value("error") ?? direct.error,
      error_description: value("error_description") ?? direct.error_description,
    };
  } catch {
    return null;
  }
}

export async function registerVkRoutes(app: FastifyInstance) {
  /** Public: the sign-in screen asks whether the VK button can work. */
  app.get("/api/auth/vk/status", async request => {
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const { clientId, scope } = vkOAuthConfig();
    return {
      configured: Boolean(clientId),
      callbackUrl: flow.callbackUrl,
      loginPath: "/api/auth/vk/start",
      scope: scope ?? null,
    };
  });

  /** Public on purpose: the visitor has no session yet. */
  app.get("/api/auth/vk/start", async (request, reply) => {
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const { clientId, scope } = vkOAuthConfig();
    if (!clientId) return redirect(reply, flow.frontendUrl, "not_configured");

    const { verifier, challenge } = createVkPkce();
    const state = createVkState();
    reply.setCookie(LOGIN_COOKIE, encodeLoginState({ state, verifier, origin: flow.origin }), {
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieSecure(request),
      path: "/",
      maxAge: LOGIN_STATE_TTL_SECONDS,
    });

    const url = vkAuthorizeUrl({ clientId, redirectUri: flow.callbackUrl, state, challenge, scope });
    return reply.redirect(url.toString());
  });

  app.get("/api/auth/vk/callback", async (request, reply) => {
    const parsed = callbackQuery.safeParse(request.query);
    const login = decodeLoginState(request.cookies?.[LOGIN_COOKIE]);
    // The cookie's origin is trusted because it was written by us; resolveOAuthFlow
    // still checks it against the allowed origins before redirecting there.
    const flow = resolveFlow(request, login?.origin);
    reply.clearCookie(LOGIN_COOKIE, { path: "/" });

    if (!parsed.success) return redirect(reply, flow.frontendUrl, "error");
    const params = callbackParams(parsed.data);
    if (!params) return redirect(reply, flow.frontendUrl, "error");
    if (!login || !params.state || login.state !== params.state) return redirect(reply, flow.frontendUrl, "state_expired");
    if (params.error) return redirect(reply, flow.frontendUrl, "denied");
    if (!params.code || !params.device_id) return redirect(reply, flow.frontendUrl, "error");

    const { clientId, serviceToken } = vkOAuthConfig();
    if (!clientId) return redirect(reply, flow.frontendUrl, "not_configured");

    let accessToken: string;
    try {
      accessToken = await exchangeVkCode({
        code: params.code,
        deviceId: params.device_id,
        verifier: login.verifier,
        redirectUri: flow.callbackUrl,
        clientId,
        state: login.state,
        serviceToken,
      });
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.message : error }, "vk id token exchange failed");
      return redirect(reply, flow.frontendUrl, "token_error");
    }

    try {
      const profile = await fetchVkProfile(accessToken, clientId);
      const user = await ensureVkAccount(profile);
      if (!(await attachSession(reply, user.id, request))) return redirect(reply, flow.frontendUrl, "blocked");
      return redirect(reply, flow.frontendUrl, "ok");
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.message : error }, "vk id sign-in failed");
      return redirect(reply, flow.frontendUrl, "profile_error");
    }
  });
}
