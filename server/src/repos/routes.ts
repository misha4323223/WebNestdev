import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { createOAuthState, consumeOAuthState, originFromOAuthState } from "../github/github-oauth-state.js";
import { redirectToApp, resolveOAuthFlow } from "../oauth/oauth-flow.js";
import { getRepoConnection, saveRepoConnection, deleteRepoConnection } from "./connection-store.js";
import { repoToken } from "./tokens.js";
import type { RepoProvider } from "./types.js";
import { createConversation, createProjectWithinLimit, ProjectLimitError } from "../project-store.js";
import { limitsForPlan } from "../account/plans.js";
import { accountPlanFor } from "../billing/store.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { getSandbox } from "../sandbox-manager.js";
import { initRepo } from "../changes/git-repo.js";

/**
 * Authorization Code + PKCE: GitVerse требует PKCE даже у конфиденциального клиента, поэтому
 * рядом с state живёт code_verifier. Он не хранится в базе: живёт минуты, привязан к state и
 * исчезает вместе с ним. Перезапуск сервера в эти минуты просто попросит начать заново.
 */
const verifiers = new Map<string, { verifier: string; expiresAt: number }>();

function saveVerifier(state: string, verifier: string) {
  const now = Date.now();
  for (const [key, value] of verifiers) if (value.expiresAt <= now) verifiers.delete(key);
  verifiers.set(state, { verifier, expiresAt: now + 15 * 60_000 });
}

function takeVerifier(state: string) {
  const found = verifiers.get(state);
  verifiers.delete(state);
  if (!found || found.expiresAt <= Date.now()) return null;
  return found.verifier;
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url").slice(0, 64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function registerRepoRoutes(app: FastifyInstance, provider: RepoProvider) {
  const base = "/api/" + provider.id;
  const oauth = provider.oauth;

  app.get(base + "/status", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveOAuthFlow(request, {
      callbackPath: base + "/callback",
      configuredCallbackUrl: undefined,
      configuredFrontendUrl: undefined,
      requestedOrigin: query.origin,
    });
    const connection = await getRepoConnection(user.id, provider.id);
    return {
      connected: Boolean(connection),
      login: connection?.login ?? null,
      configured: oauth ? Boolean(oauth.clientId && oauth.clientSecret) : true,
      callbackUrl: flow.callbackUrl,
      tokenUrl: provider.tokenUrl,
      oauthScope: oauth?.scope ?? null,
    };
  });

  if (oauth) {
    app.get(base + "/connect", async (request, reply) => {
      const user = await requireUser(request, reply); if (!user) return;
      const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
      const flow = resolveOAuthFlow(request, {
        callbackPath: base + "/callback",
        requestedOrigin: query.origin,
      });
      if (!oauth.clientId || !oauth.clientSecret) return redirectToApp(reply, flow.frontendUrl, provider.id, "not_configured");
      const state = await createOAuthState(user.id, flow.origin);
      const { verifier, challenge } = pkce();
      saveVerifier(state, verifier);
      const url = new URL(oauth.authorizeUrl);
      url.searchParams.set("client_id", oauth.clientId);
      url.searchParams.set("redirect_uri", flow.callbackUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", oauth.scope);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return reply.redirect(url.toString());
    });

    app.get(base + "/callback", async (request, reply) => {
      const user = await requireUser(request, reply); if (!user) return;
      const query = z.object({
        state: z.string().min(1),
        code: z.string().min(1).optional(),
        error: z.string().optional(),
      }).parse(request.query);
      const flow = resolveOAuthFlow(request, {
        callbackPath: base + "/callback",
        requestedOrigin: originFromOAuthState(query.state) ?? undefined,
      });
      if (query.error) return redirectToApp(reply, flow.frontendUrl, provider.id, "denied");
      if (!query.code) return redirectToApp(reply, flow.frontendUrl, provider.id, "error");
      const owner = await consumeOAuthState(query.state);
      const verifier = takeVerifier(query.state);
      if (!owner || owner !== user.id || !verifier) return redirectToApp(reply, flow.frontendUrl, provider.id, "state_expired");
      try {
        const response = await fetch(oauth.tokenUrl, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: query.code,
            redirect_uri: flow.callbackUrl,
            client_id: oauth.clientId as string,
            client_secret: oauth.clientSecret as string,
            code_verifier: verifier,
          }),
        });
        const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
        if (!token.access_token) return redirectToApp(reply, flow.frontendUrl, provider.id, "token_error");
        const login = await provider.loginFromToken(token.access_token);
        await saveRepoConnection({
          userId: user.id,
          provider: provider.id,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? null,
          expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
          login,
          baseUrl: provider.webBase,
        });
        return redirectToApp(reply, flow.frontendUrl, provider.id, "connected");
      } catch {
        return redirectToApp(reply, flow.frontendUrl, provider.id, "token_error");
      }
    });
  }

  app.post(base + "/token", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ token: z.string().min(8).max(500) }).parse(request.body);
    const token = body.token.trim();
    // Токены GitVerse — JWT с точками, SourceCraft — обычная строка; пробелы и кавычки означают,
    // что скопировали не то, и это лучше сказать сразу.
    if (!/^[A-Za-z0-9_.\-]+$/.test(token)) {
      return reply.code(400).send({ error: "Токен содержит лишние символы — скопируйте его целиком, без пробелов, кавычек и переносов строк" });
    }
    try {
      const login = await provider.loginFromToken(token);
      await saveRepoConnection({ userId: user.id, provider: provider.id, accessToken: token, login, baseUrl: provider.webBase });
      return { connected: true, login };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post(base + "/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    await deleteRepoConnection(user.id, provider.id);
    return { connected: false };
  });

  app.get(base + "/repositories", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const token = await repoToken(user.id, provider.id);
    if (!token) return reply.code(400).send({ error: provider.name + " не подключён" });
    try {
      return { repositories: await provider.listRepositories(token) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post(base + "/import", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ id: z.string().min(1).max(300) }).parse(request.body);
    const token = await repoToken(user.id, provider.id);
    if (!token) return reply.code(400).send({ error: provider.name + " не подключён" });
    const repository = await provider.getRepository(token, body.id);
    const plan = await accountPlanFor(user.id);
    let project;
    try {
      project = await createProjectWithinLimit(repository.name, {
        provider: provider.id,
        owner: repository.owner,
        name: repository.name,
        fullName: repository.fullName,
        defaultBranch: repository.defaultBranch,
        url: repository.url,
        ...(repository.cloneUrl ? { cloneUrl: repository.cloneUrl } : {}),
      }, user.id, limitsForPlan(plan).projects);
    } catch (error) {
      if (error instanceof ProjectLimitError) {
        return reply.code(403).send({ error: error.message, code: "PROJECT_LIMIT_REACHED", limit: error.limit, used: error.used, plan });
      }
      throw error;
    }
    const sandbox = await getSandbox(project.id, user.id);
    const importedFiles = await provider.importRepository(token, repository, sandbox.root);
    // У GitVerse история ставится на настоящую ветку (как у GitHub и GitLab), чтобы первая же
    // задача отправлялась fast-forward. SourceCraft уже пришёл клоном с историей.
    if (provider.id === "gitverse" && repository.cloneUrl) {
      try {
        const history = await initRepo(sandbox.root, {
          branch: repository.defaultBranch,
          remoteUrl: repository.cloneUrl,
          token,
          username: provider.gitUsername,
        });
        if (history.warning) console.warn("[repos] " + repository.fullName + ": " + history.warning);
      } catch (error) {
        console.error("[repos] не удалось создать историю импортированного проекта", error);
      }
    }
    await recordStorageMutation(project.id, user.id, { heavy: true })
      .catch(error => console.warn("[storage] не удалось обновить размер после импорта", error));
    const conversation = await createConversation(project.id, provider.name + ": " + repository.fullName);
    return reply.code(201).send({ project, conversation, importedFiles });
  });
}
