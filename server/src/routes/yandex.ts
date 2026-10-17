import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { createOAuthState, consumeOAuthState, originFromOAuthState } from "../github/github-oauth-state.js";
import { getYandexConnection, saveYandexConnection, deleteYandexConnection } from "../yandex/yandex-connection-store.js";
import { fetchYandexLogin, saveVerifiedYandexCredential, yandexStatus } from "../yandex/yandex-api.js";
import { resolveOAuthFlow, redirectToApp, type OAuthFlowOptions } from "../oauth/oauth-flow.js";
import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * Ключи Yandex ID читаются на каждый запрос через getPlatformEnv: их можно поставить в
 * панели «Ключи сервера», и подключение заработает без перезапуска. Пустое значение
 * означает «не задано» — compose передаёт незаданную переменную пустой строкой.
 *
 * Yandex Cloud выдаёт доступ через роли, а не через scope, поэтому oauthScope — только часть
 * регистрации приложения. Ключ сервисного аккаунта ниже всё равно остаётся основным путём:
 * Yandex Cloud перестал принимать новые OAuth-токены Yandex ID.
 */
export function yandexOAuthConfig() {
  const read = (name: string) => getPlatformEnv(name)?.trim() || undefined;
  return {
    clientId: read("YANDEX_CLIENT_ID"),
    clientSecret: read("YANDEX_CLIENT_SECRET"),
    configuredCallbackUrl: read("YANDEX_CALLBACK_URL"),
    configuredFrontendUrl: read("YANDEX_FRONTEND_URL"),
    scope: read("YANDEX_OAUTH_SCOPE") ?? "cloud-api",
  };
}

function resolveFlow(request: Parameters<typeof resolveOAuthFlow>[0], requestedOrigin?: string) {
  const { configuredCallbackUrl, configuredFrontendUrl } = yandexOAuthConfig();
  const options: OAuthFlowOptions = { callbackPath: "/api/yandex/callback", configuredCallbackUrl, configuredFrontendUrl, requestedOrigin };
  return resolveOAuthFlow(request, options);
}

function redirect(reply: { redirect: (url: string) => unknown }, frontendUrl: string, status: string) {
  return redirectToApp(reply, frontendUrl, "yandex", status);
}

export async function registerYandexRoutes(app: FastifyInstance) {
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
    const state = await createOAuthState(user.id, flow.origin);
    const url = new URL("https://oauth.yandex.com/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", flow.callbackUrl);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/api/yandex/callback", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({
      state: z.string().min(1),
      code: z.string().min(1).optional(),
      error: z.string().optional(),
    }).parse(request.query);
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
