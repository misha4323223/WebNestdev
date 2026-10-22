import type { FastifyInstance } from "fastify";
import { z } from "zod";
import path from "node:path";
import { requireUser } from "../auth/auth.js";
import { resolveOAuthFlow, redirectToApp, type OAuthFlowOptions } from "../oauth/oauth-flow.js";
import { getGitLabConnection, saveGitLabConnection, deleteGitLabConnection } from "../gitlab/gitlab-connection-store.js";
import { createOAuthState, consumeOAuthState, originFromOAuthState } from "../github/github-oauth-state.js";
import { getGitLabLoginFromToken, getGitLabUser, listGitLabRepositories, getGitLabProject, getGitLabTree, getGitLabFile, gitlabBaseUrl } from "../gitlab/gitlab-api.js";
import { createConversation, createProjectWithinLimit, ProjectLimitError } from "../project-store.js";
import { limitsForPlan, repositoryImportLimitFor, repositorySizeLabel } from "../account/plans.js";
import { accountPlanFor } from "../billing/store.js";
import { recordStorageMutation } from "../account/storage-quota.js";
import { getSandbox } from "../sandbox-manager.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { initRepo } from "../changes/git-repo.js";
import { writeFileInside } from "../sandbox/path-guard.js";

// read_api/read_repository — импорт, write_repository — отправка коммитов обратно в GitLab.
const oauthScope = "read_api read_repository write_repository";

/**
 * Настройки OAuth-приложения читаются на каждый запрос, чтобы ключи из панели «Ключи сервера»
 * начинали работать без перезапуска. `GITLAB_BASE_URL` позволяет подключить свой GitLab, а не
 * только gitlab.com — тогда callback и API идут на тот же адрес.
 */
function gitlabOAuthConfig() {
  const read = (name: string) => getPlatformEnv(name)?.trim() || undefined;
  return {
    clientId: read("GITLAB_CLIENT_ID"),
    clientSecret: read("GITLAB_CLIENT_SECRET"),
    baseUrl: (read("GITLAB_BASE_URL") || "https://gitlab.com").replace(/\/+$/, ""),
    configuredCallbackUrl: read("GITLAB_CALLBACK_URL"),
    configuredFrontendUrl: read("GITLAB_FRONTEND_URL"),
  };
}

function resolveFlow(request: Parameters<typeof resolveOAuthFlow>[0], requestedOrigin?: string) {
  const { configuredCallbackUrl, configuredFrontendUrl } = gitlabOAuthConfig();
  const options: OAuthFlowOptions = { callbackPath: "/api/gitlab/callback", configuredCallbackUrl, configuredFrontendUrl, requestedOrigin };
  return resolveOAuthFlow(request, options);
}

function redirect(reply: { redirect: (url: string) => unknown }, frontendUrl: string, status: string) {
  return redirectToApp(reply, frontendUrl, "gitlab", status);
}

export async function registerGitLabRoutes(app: FastifyInstance) {
  const startup = gitlabOAuthConfig();
  if (process.env.NODE_ENV === "production" && startup.clientId && startup.clientSecret) {
    if ((startup.configuredCallbackUrl && !/^https:\/\//i.test(startup.configuredCallbackUrl)) || (startup.configuredFrontendUrl && !/^https:\/\//i.test(startup.configuredFrontendUrl))) {
      throw new Error("В production GitLab OAuth требует HTTPS-адреса callback и фронтенда");
    }
  }

  app.get("/api/gitlab/status", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const connection = await getGitLabConnection(user.id);
    const { clientId, clientSecret, baseUrl } = gitlabOAuthConfig();
    return {
      connected: Boolean(connection),
      gitlabLogin: connection?.gitlabLogin ?? null,
      baseUrl: connection?.baseUrl ?? baseUrl,
      configured: Boolean(clientId && clientSecret),
      callbackUrl: flow.callbackUrl,
      scope: oauthScope,
    };
  });

  app.get("/api/gitlab/connect", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({ origin: z.string().max(500).optional() }).parse(request.query);
    const flow = resolveFlow(request, query.origin);
    const { clientId, clientSecret, baseUrl } = gitlabOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured");
    const state = await createOAuthState(user.id, flow.origin);
    const url = new URL(baseUrl + "/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", flow.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", oauthScope);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/api/gitlab/callback", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const query = z.object({
      state: z.string().min(1),
      code: z.string().min(1).optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    }).parse(request.query);
    const flow = resolveFlow(request, originFromOAuthState(query.state) ?? undefined);
    if (query.error) return redirect(reply, flow.frontendUrl, "denied");
    if (!query.code) return redirect(reply, flow.frontendUrl, "error");
    const { clientId, clientSecret, baseUrl } = gitlabOAuthConfig();
    if (!clientId || !clientSecret) return redirect(reply, flow.frontendUrl, "not_configured");
    const oauthUserId = await consumeOAuthState(query.state);
    if (!oauthUserId || oauthUserId !== user.id) return redirect(reply, flow.frontendUrl, "state_expired");
    let token: { access_token?: string };
    try {
      const response = await fetch(baseUrl + "/oauth/token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: query.code,
          grant_type: "authorization_code",
          redirect_uri: flow.callbackUrl,
        }),
      });
      token = await response.json() as { access_token?: string };
    } catch {
      return redirect(reply, flow.frontendUrl, "token_error");
    }
    if (!token.access_token) return redirect(reply, flow.frontendUrl, "token_error");
    try {
      const gitlabUser = await getGitLabUserWithToken(baseUrl, token.access_token);
      await saveGitLabConnection(user.id, token.access_token, gitlabUser, baseUrl);
      return redirect(reply, flow.frontendUrl, "connected");
    } catch {
      return redirect(reply, flow.frontendUrl, "profile_error");
    }
  });

  /**
   * Личный токен работает без OAuth-приложения: так GitLab можно подключить на любом сервере,
   * где `GITLAB_CLIENT_ID` и `GITLAB_CLIENT_SECRET` никто не заводил. Токен проверяется у GitLab,
   * шифруется и хранится как обычное подключение.
   */
  app.post("/api/gitlab/token", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ token: z.string().min(20).max(500), baseUrl: z.string().url().max(500).optional() }).parse(request.body);
    const token = body.token.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
      return reply.code(400).send({ error: "Токен GitLab содержит лишние символы — скопируйте его целиком, без пробелов, кавычек и переносов строк" });
    }
    const baseUrl = (body.baseUrl?.trim() || gitlabBaseUrl()).replace(/\/+$/, "");
    try {
      const gitlabLogin = await getGitLabLoginFromToken(token, baseUrl);
      await saveGitLabConnection(user.id, token, gitlabLogin, baseUrl);
      return { connected: true, gitlabLogin, baseUrl };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/gitlab/disconnect", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    await deleteGitLabConnection(user.id);
    return { connected: false };
  });

  app.get("/api/gitlab/repositories", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    try {
      return { repositories: await listGitLabRepositories(user.id) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/gitlab/me", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    return getGitLabUser(user.id);
  });

  app.post("/api/gitlab/import", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const body = z.object({ id: z.number().int().positive() }).parse(request.body);
    const repository = await getGitLabProject(user.id, body.id);
    const branch = repository.default_branch?.trim() || "main";
    const plan = await accountPlanFor(user.id);
    const repositoryLimit = repositoryImportLimitFor(plan);
    const sizeBytes = Number(repository.statistics?.repository_size ?? 0);
    if (repositoryLimit !== null && sizeBytes > repositoryLimit) {
      return reply.code(403).send({
        error: "Репозиторий занимает " + repositorySizeLabel(sizeBytes) + ", а на бесплатном тарифе импорт ограничен " + repositorySizeLabel(repositoryLimit) + ". Оформите платный тариф или импортируйте проект меньше " + repositorySizeLabel(repositoryLimit) + ".",
        code: "REPOSITORY_TOO_LARGE",
        sizeBytes,
        limitBytes: repositoryLimit,
        plan,
      });
    }
    const projectLimit = limitsForPlan(plan).projects;
    let project;
    try {
      project = await createProjectWithinLimit(repository.name, {
        provider: "gitlab",
        owner: repository.namespace?.full_path ?? "",
        name: repository.path || repository.name,
        fullName: repository.path_with_namespace,
        defaultBranch: branch,
        url: repository.web_url,
        ...(repository.http_url_to_repo ? { cloneUrl: repository.http_url_to_repo } : {}),
      }, user.id, projectLimit);
    } catch (error) {
      if (error instanceof ProjectLimitError) {
        return reply.code(403).send({ error: error.message, code: "PROJECT_LIMIT_REACHED", limit: error.limit, used: error.used, plan });
      }
      throw error;
    }
    const sandbox = await getSandbox(project.id, user.id);
    const tree = await getGitLabTree(user.id, repository.id, branch);
    const files = tree.filter(entry => entry.type === "blob" && entry.path);
    if (files.length > 5000) throw new Error("В репозитории слишком много файлов для импорта");
    for (const entry of files) {
      const content = await getGitLabFile(user.id, repository.id, entry.path, branch);
      await writeFileInside(sandbox.root, path.join(sandbox.root, entry.path), content);
    }
    try {
      const connection = await getGitLabConnection(user.id);
      const history = await initRepo(sandbox.root, {
        branch,
        remoteUrl: repository.http_url_to_repo || repository.web_url,
        token: connection?.accessToken ?? null,
        username: "oauth2",
      });
      if (history.warning) console.warn("[changes] " + repository.path_with_namespace + ": " + history.warning);
    } catch (error) {
      console.error("[changes] не удалось создать историю импортированного проекта", error);
    }
    await recordStorageMutation(project.id, user.id, { heavy: true })
      .catch(error => console.warn("[storage] не удалось обновить размер после импорта", error));
    const conversation = await createConversation(project.id, "GitLab: " + repository.path_with_namespace);
    return reply.code(201).send({ project, conversation, importedFiles: files.length });
  });
}

/** Профиль по только что выданному токену: подключение ещё не сохранено, поэтому без store. */
async function getGitLabUserWithToken(baseUrl: string, token: string) {
  const response = await fetch(baseUrl.replace(/\/+$/, "") + "/api/v4/user", {
    headers: { Accept: "application/json", Authorization: "Bearer " + token },
  });
  if (!response.ok) throw new Error("GitLab не вернул профиль");
  const user = await response.json() as { username?: string };
  if (!user.username) throw new Error("GitLab не вернул имя пользователя");
  return user.username;
}
