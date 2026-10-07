import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getGitHubConnection, saveGitHubConnection } from "../github/github-connection-store.js";
import { createOAuthState, consumeOAuthState } from "../github/github-oauth-state.js";
import { getGitHubUser, listGitHubRepositories } from "../github/github-api.js";

const clientId = process.env.GITHUB_CLIENT_ID;
const clientSecret = process.env.GITHUB_CLIENT_SECRET;
const callbackUrl = process.env.GITHUB_CALLBACK_URL ?? "http://localhost:8787/api/github/callback";

export async function registerGitHubRoutes(app: FastifyInstance) {
  app.get("/api/github/status", async () => {
    const connection = await getGitHubConnection();
    return { connected: Boolean(connection), githubLogin: connection?.githubLogin ?? null };
  });

  app.get("/api/github/connect", async (_request, reply) => {
    if (!clientId || !clientSecret) {
      return reply.code(503).send({ error: "GitHub OAuth is not configured", required: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] });
    }
    const state = createOAuthState();
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("scope", "repo");
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get("/api/github/callback", async (request, reply) => {
    if (!clientId || !clientSecret) return reply.code(503).send({ error: "GitHub OAuth is not configured" });
    const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(request.query);
    if (!consumeOAuthState(query.state)) return reply.code(400).send({ error: "Invalid or expired GitHub OAuth state" });

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code: query.code, redirect_uri: callbackUrl }),
    });
    const token = await response.json() as { access_token?: string; error?: string };
    if (!token.access_token) return reply.code(400).send({ error: token.error ?? "GitHub OAuth token exchange failed" });

    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + token.access_token, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!userResponse.ok) return reply.code(400).send({ error: "GitHub user lookup failed" });
    const user = await userResponse.json() as { login?: string };
    await saveGitHubConnection(token.access_token, user.login);
    return reply.redirect("/?github=connected");
  });

  app.get("/api/github/repositories", async () => ({ repositories: await listGitHubRepositories() }));

  app.get("/api/github/me", async () => getGitHubUser());
}
