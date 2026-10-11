import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { resolveOAuthFlow, redirectToApp, type OAuthFlowOptions } from "../oauth/oauth-flow.js";
import { getGitHubConnection, saveGitHubConnection, deleteGitHubConnection } from "../github/github-connection-store.js";
import { createOAuthState, consumeOAuthState, originFromOAuthState } from "../github/github-oauth-state.js";
import { getGitHubUser, listGitHubRepositories, getGitHubRepository, getGitHubTree, getGitHubBlob } from "../github/github-api.js";
import { createConversation, createProjectWithinLimit, ProjectLimitError } from "../project-store.js";
import { getSubscription } from "../account/account-store.js";
import { limitsForPlan, type PlanId } from "../account/plans.js";
import { getSandbox } from "../sandbox-manager.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const clientId = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;
const configuredCallbackUrl = process.env.GITHUB_CALLBACK_URL;
const configuredFrontendUrl = process.env.GITHUB_FRONTEND_URL;
const oauthScope = "repo";

/**
 * The shared OAuth flow policy (allowed origins, callback URL, return to the app) lives
 * in oauth/oauth-flow.ts so GitHub and Yandex behave identically.
 */
function resolveFlow(request: Parameters<typeof resolveOAuthFlow>[0], requestedOrigin?: string) {
  const options: OAuthFlowOptions = { callbackPath: "/api/github/callback", configuredCallbackUrl, configuredFrontendUrl, requestedOrigin };
  return resolveOAuthFlow(request, options);
}

function redirect(reply: { redirect: (url: string) => unknown }, frontendUrl: string, status: string) {
  return redirectToApp(reply, frontendUrl, "github", status);
}

if (process.env.NODE_ENV === "production" && clientId && clientSecret) {
  if ((configuredCallbackUrl && !/^https:\/\//i.test(configuredCallbackUrl)) || (configuredFrontendUrl && !/^https:\/\//i.test(configuredFrontendUrl))) {
    throw new Error("В production GitHub OAuth требует HTTPS-адреса callback и фронтенда");
  }
}

export async function registerGitHubRoutes(app: FastifyInstance) {
  app.get("/api/github/status", async (request,reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const query=z.object({origin:z.string().max(500).optional()}).parse(request.query);
    const flow=resolveFlow(request,query.origin);
    const connection = await getGitHubConnection(user.id);
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
    const subscription = await getSubscription(user.id);
    const plan: PlanId = subscription.status === "demo_active" && subscription.expiresAt && Date.parse(subscription.expiresAt) > Date.now()
      ? subscription.plan
      : "free";
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
