import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { resolveOAuthFlow, redirectToApp, type OAuthFlowOptions } from "../oauth/oauth-flow.js";
import { getGitHubConnection, saveGitHubConnection, deleteGitHubConnection } from "../github/github-connection-store.js";
import { createOAuthState, consumeOAuthState, originFromOAuthState } from "../github/github-oauth-state.js";
import { getGitHubUser, getGitHubLoginFromToken, listGitHubRepositories, getGitHubRepository, getGitHubTree, getGitHubBlob } from "../github/github-api.js";
import { createConversation, createProjectWithinLimit, ProjectLimitError } from "../project-store.js";
import { FREE_PLAN, limitsForPlan, type PlanId } from "../account/plans.js";
import { getSandbox } from "../sandbox-manager.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const oauthScope = "repo";

/**
 * OAuth-приложение GitHub читается на каждый запрос, а не один раз при старте: ключи можно
 * поставить в панели «Ключи сервера» (platform/platform-env.ts), и вход должен заработать
 * сразу, без перезапуска сервиса. Переменные окружения остаются запасным источником, поэтому
 * выкладка, где ключи заданы в .env, ведёт себя как раньше.
 */
function githubOAuthConfig() {
  return {
    clientId: getPlatformEnv("GITHUB_CLIENT_ID")?.trim(),
    clientSecret: getPlatformEnv("GITHUB_CLIENT_SECRET")?.trim(),
    configuredCallbackUrl: getPlatformEnv("GITHUB_CALLBACK_URL")?.trim(),
    configuredFrontendUrl: getPlatformEnv("GITHUB_FRONTEND_URL")?.trim(),
  };
}

/**
 * The shared OAuth flow policy (allowed origins, callback URL, return to the app) lives
 * in oauth/oauth-flow.ts so GitHub and Yandex behave identically.
 */
function resolveFlow(request: Parameters<typeof resolveOAuthFlow>[0], requestedOrigin?: string) {
  const { configuredCallbackUrl, configuredFrontendUrl } = githubOAuthConfig();
  const options: OAuthFlowOptions = { callbackPath: "/api/github/callback", configuredCallbackUrl, configuredFrontendUrl, requestedOrigin };
  return resolveOAuthFlow(request, options);
}

function redirect(reply: { redirect: (url: string) => unknown }, frontendUrl: string, status: string) {
  return redirectToApp(reply, frontendUrl, "github", status);
}

export async function registerGitHubRoutes(app: FastifyInstance) {
  const startup = githubOAuthConfig();
  if (process.env.NODE_ENV === "production" && startup.clientId && startup.clientSecret) {
    if ((startup.configuredCallbackUrl && !/^https:\/\//i.test(startup.configuredCallbackUrl)) || (startup.configuredFrontendUrl && !/^https:\/\//i.test(startup.configuredFrontendUrl))) {
      throw new Error("В production GitHub OAuth требует HTTPS-адреса callback и фронтенда");
    }
  }
  app.get("/api/github/status", async (request,reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const query=z.object({origin:z.string().max(500).optional()}).parse(request.query);
    const flow=resolveFlow(request,query.origin);
    const connection = await getGitHubConnection(user.id);
    const { clientId, clientSecret } = githubOAuthConfig();
    return {
      connected: Boolean(connection),
      githubLogin: connection?.githubLogin ?? null,
      configured: Boolean(clientId && clientSecret),
      callbackUrl: flow.callbackUrl,
      scope: oauthScope,
    };
  });

  app.get("/api/github/connect", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const query=z.object({origin:z.string().max(500).optional()}).parse(request.query);
    const flow=resolveFlow(request,query.origin);
    const { clientId, clientSecret } = githubOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured");
    const state = await createOAuthState(user.id, flow.origin);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", flow.callbackUrl);
    url.searchParams.set("scope", oauthScope);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "true");
    return reply.redirect(url.toString());
  });

  app.get("/api/github/callback", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const query = z.object({
      state: z.string().min(1),
      code: z.string().min(1).optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }).parse(request.query);
    const flow = resolveFlow(request, originFromOAuthState(query.state) ?? undefined);
    if (query.error) return redirect(reply, flow.frontendUrl, "denied");
    if (!query.code) return redirect(reply, flow.frontendUrl, "error");
    const { clientId, clientSecret } = githubOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured");
    const oauthUserId = await consumeOAuthState(query.state);
    if (!oauthUserId || oauthUserId !== user.id) return redirect(reply, flow.frontendUrl, "state_expired");
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: query.code, redirect_uri: flow.callbackUrl }),
    });
    const token = await response.json() as { access_token?: string; error?: string };
    if (!token.access_token) return redirect(reply, flow.frontendUrl, "token_error");
    const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token.access_token, "X-GitHub-Api-Version": "2022-11-28" } });
    if (!userResponse.ok) return redirect(reply, flow.frontendUrl, "profile_error");
    const githubUser = await userResponse.json() as { login?: string };
    await saveGitHubConnection(user.id, token.access_token, githubUser.login);
    return redirect(reply, flow.frontendUrl, "connected");
  });

  /**
   * Подключение личным токеном: своё OAuth-приложение GitHub для этого не нужно, поэтому способ
   * работает на любом сервере — в том числе там, где `GITHUB_CLIENT_ID` и `GITHUB_CLIENT_SECRET`
   * никто не заводил. Токен проверяется у GitHub, шифруется и хранится как обычное подключение,
   * поэтому статус, импорт репозиториев и отключение работают без изменений.
   */
  app.post("/api/github/token", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const body = z.object({ token: z.string().min(20).max(500) }).parse(request.body);
    // Скопированный с переносом строки или кавычками токен легко принять за недействительный.
    const token=body.token.trim();
    if(!/^[A-Za-z0-9_-]+$/.test(token)){
      return reply.code(400).send({ error: "Токен GitHub содержит лишние символы — скопируйте его целиком, без пробелов, кавычек и переносов строк" });
    }
    try {
      const githubLogin = await getGitHubLoginFromToken(token);
      await saveGitHubConnection(user.id, token, githubLogin);
      return { connected: true, githubLogin };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/github/disconnect", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    await deleteGitHubConnection(user.id);
    return { connected: false };
  });

  app.get("/api/github/repositories", async (request,reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    return { repositories: await listGitHubRepositories(user.id) };
  });
  app.get("/api/github/me", async (request,reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    return getGitHubUser(user.id);
  });

  app.post("/api/github/import", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const body = z.object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) }).parse(request.body);
    const repository = await getGitHubRepository(user.id, body.owner, body.repo);
    const plan: PlanId = FREE_PLAN;
    const limit = limitsForPlan(plan).projects;
    let project;
    try {
      project = await createProjectWithinLimit(repository.name, {
        owner: repository.owner.login,
        name: repository.name,
        fullName: repository.full_name,
        defaultBranch: repository.default_branch,
        url: repository.html_url,
      }, user.id, limit);
    } catch (error) {
      if (error instanceof ProjectLimitError) {
        return reply.code(403).send({ error: error.message, code: "PROJECT_LIMIT_REACHED", limit: error.limit, used: error.used, plan });
      }
      throw error;
    }
    const sandbox = await getSandbox(project.id,user.id);
    const tree = await getGitHubTree(user.id, repository.owner.login, repository.name, repository.default_branch);
    const files = tree.tree.filter((entry: { type: string; path: string }) => entry.type === "blob" && entry.path);
    if (files.length > 5000) throw new Error("В репозитории слишком много файлов для импорта");
    for (const entry of files) {
      const blob = await getGitHubBlob(user.id, repository.owner.login, repository.name, entry.path);
      if (blob.encoding !== "base64") continue;
      const target = path.join(sandbox.root, entry.path);
      if (!target.startsWith(sandbox.root + path.sep)) throw new Error("Небезопасный путь в репозитории");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(blob.content.replace(/\n/g, ""), "base64"));
    }
    const conversation = await createConversation(project.id, "GitHub: " + repository.full_name);
    return reply.code(201).send({ project, conversation, importedFiles: files.length });
  });
}
