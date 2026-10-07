import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getGitHubConnection, saveGitHubConnection } from "../github/github-connection-store.js";
import { createOAuthState, consumeOAuthState } from "../github/github-oauth-state.js";
import { getGitHubUser, listGitHubRepositories, getGitHubRepository, getGitHubTree, getGitHubBlob } from "../github/github-api.js";
import { createConversation, createProject } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const clientId = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;
const callbackUrl = process.env.GITHUB_CALLBACK_URL ?? "http://localhost:8787/api/github/callback";
const frontendUrl = process.env.GITHUB_FRONTEND_URL ?? "http://localhost:5173/";

export async function registerGitHubRoutes(app: FastifyInstance) {
  app.get("/api/github/status", async (request,reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    const connection = await getGitHubConnection(user.id);
    return { connected: Boolean(connection), githubLogin: connection?.githubLogin ?? null };
  });

  app.get("/api/github/connect", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    if (!clientId || !clientSecret) return reply.code(503).send({ error: "GitHub OAuth is not configured", required: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] });
    const state = createOAuthState(user.id);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("scope", "repo");
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/api/github/callback", async (request, reply) => {
    const user=await requireUser(request,reply); if(!user)return;
    if (!clientId || !clientSecret) return reply.code(503).send({ error: "GitHub OAuth is not configured" });
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    const oauthUserId = consumeOAuthState(query.state); if (!oauthUserId || oauthUserId !== user.id) return reply.code(400).send({ error: "Invalid or expired GitHub OAuth state" });
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: query.code, redirect_uri: callbackUrl }),
    });
    const token = await response.json() as { access_token?: string; error?: string };
    if (!token.access_token) return reply.code(400).send({ error: token.error ?? "GitHub OAuth token exchange failed" });
    const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token.access_token, "X-GitHub-Api-Version": "2022-11-28" } });
    if (!userResponse.ok) return reply.code(400).send({ error: "GitHub user lookup failed" });
    const githubUser = await userResponse.json() as { login?: string };
    await saveGitHubConnection(user.id, token.access_token, githubUser.login);
    return reply.redirect(frontendUrl + (frontendUrl.includes("?") ? "&" : "?") + "github=connected");
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
    const project = await createProject(repository.name, {
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      url: repository.html_url,
    }, user.id);
    const sandbox = await getSandbox(project.id);
    const tree = await getGitHubTree(user.id, repository.owner.login, repository.name, repository.default_branch);
    const files = tree.tree.filter((entry: { type: string; path: string }) => entry.type === "blob" && entry.path);
    if (files.length > 5000) throw new Error("Repository contains too many files to import");
    for (const entry of files) {
      const blob = await getGitHubBlob(user.id, repository.owner.login, repository.name, entry.path);
      if (blob.encoding !== "base64") continue;
      const target = path.join(sandbox.root, entry.path);
      if (!target.startsWith(sandbox.root + path.sep)) throw new Error("Unsafe repository path");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(blob.content.replace(/\n/g, ""), "base64"));
    }
    const conversation = await createConversation(project.id, "GitHub: " + repository.full_name);
    return reply.code(201).send({ project, conversation, importedFiles: files.length });
  });
}
