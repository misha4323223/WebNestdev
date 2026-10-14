import Fastify from "fastify";
import { ZodError } from "zod";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { initializeStorage, closeStorage, describeStorage } from "./storage/ydb.js";
import { reapOrphanPreviews } from "./preview-manager.js";
import { startPreviewSweeper } from "./preview/idle-sweep.js";
import { describePreviewMode } from "./preview/static-preview.js";
import { describePreviewLimits } from "./preview/preview-limiter.js";
import { describeRunLimiter } from "./agent/run-limiter.js";
import { describeSandboxLimiter } from "./sandbox/sandbox-limiter.js";
import { assertEncryptionConfigured } from "./storage/secret-crypto.js";
import { ensureDataDir } from "./project-store.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerAgentWebSocket } from "./routes/agent-ws.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerGitHubRoutes } from "./routes/github.js";
import { registerYandexRoutes } from "./routes/yandex.js";
import { registerDatabaseRoutes } from "./routes/database.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerPhoneAuthRoutes } from "./routes/phone-auth.js";
import { registerAccountRoutes } from "./routes/account.js";
import { ensureDemoUser } from "./auth/auth-store.js";
import "./tools/project-tools.js";
import "./tools/filesystem-tools.js";
import "./tools/terminal-tools.js";
import "./tools/git-tools.js";
import "./tools/preview-tools.js";
import "./tools/browser-tools.js";
import "./tools/verification-tools.js";
import "./tools/plan-tools.js";
import "./tools/yandex-tools.js";
import "./tools/database-tools.js";

assertEncryptionConfigured();

const app=Fastify({logger:true,bodyLimit:2_000_000,requestTimeout:120_000});
const production = process.env.NODE_ENV === "production";
const configuredOrigins = process.env.WEBNESTDEV_ALLOWED_ORIGINS;
if (production && !configuredOrigins) throw new Error("В production обязательна переменная WEBNESTDEV_ALLOWED_ORIGINS");
const allowedOrigins = (configuredOrigins ?? "").split(",").map(value => value.trim()).filter(Boolean);
if (production && allowedOrigins.some(origin => /^https?:\/\/localhost(?::\d+)?$/i.test(origin))) {
  throw new Error("В production в WEBNESTDEV_ALLOWED_ORIGINS нельзя указывать localhost");
}
await ensureDataDir();
// The live backend is printed once at startup: it is the first thing to check when an
// account, a conversation or an integration seems to have disappeared.
console.log("[storage] " + describeStorage());
// Which preview mode this host runs is the first thing to check when memory or a project's
// preview behaves unexpectedly (PREVIEW_MODE: auto | static | container).
console.log("[preview] " + describePreviewMode() + "; " + describePreviewLimits());
// How many conversations this host runs in parallel (AGENT_MAX_CONCURRENT_RUNS) and how many
// containers they may start at once (SANDBOX_MAX_CONCURRENT). The second line is the memory
// one: a run is mostly waiting on the model, a container is what costs RAM.
console.log("[agent] " + describeRunLimiter());
console.log("[sandbox] " + describeSandboxLimiter());
// База инициализируется в фоне: DDL на «холодной» серверлесс-базе занимает 30–60 с.
// Если дождаться её здесь, app.listen() так и не выполнится (порт 8787 не поднимется,
// а healthcheck и клиенты не дождутся ответа). HTTP стартует сразу; DDL отрабатывает в фоне.
initializeStorage().catch((err) => {
  console.error("[storage] init failed (background):", err?.message ?? err);
});

const demoEnabled = process.env.WEBNESTDEV_DEMO_USER ? process.env.WEBNESTDEV_DEMO_USER !== "0" : !production;
if (demoEnabled) {
  const demo = await ensureDemoUser();
  app.log.info({ demoEmail: demo.email, created: demo.created }, "demo account ready");
}

app.addHook("onClose", async () => { await closeStorage(); });

app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  // SAMEORIGIN, not DENY: the live preview of a user's project is framed by our own
  // workspace, and DENY made the browser refuse to render it.
  reply.header("X-Frame-Options", "SAMEORIGIN");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Некорректный запрос",
      issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    });
  }
  request.log.error(error);
  if (reply.sent) return;
  return reply.code(500).send({ error: "Внутренняя ошибка сервера" });
});
// In development the browser origin varies (localhost, LAN IP, hosted preview
// domain), so any origin is reflected unless WEBNESTDEV_ALLOWED_ORIGINS pins a list.
await app.register(cors,{origin: production || configuredOrigins ? allowedOrigins : true, credentials:true});
await app.register(cookie);
await app.register(websocket);

await registerHealthRoutes(app);
await registerAuthRoutes(app);
await registerPhoneAuthRoutes(app);
await registerAccountRoutes(app);
await registerProjectRoutes(app);
await registerPreviewRoutes(app);
await registerToolRoutes(app);
await registerWorkspaceRoutes(app);
await registerProviderRoutes(app);
await registerGitHubRoutes(app);
await registerYandexRoutes(app);
await registerDatabaseRoutes(app);
await registerAgentWebSocket(app);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
if (fs.existsSync(rootDir)) {
  await app.register(fastifyStatic, {
    root: rootDir,
    maxAge: "30d",
    immutable: true,
  });
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? "";
    if (request.method === "GET" && !url.startsWith("/api")) {
      return reply.sendFile("index.html", { maxAge: 0, immutable: false });
    }
    return reply.code(404).send({ error: "Not Found" });
  });
}


await app.listen({host:"0.0.0.0",port:Number(process.env.PORT??8787)});
// Preview containers outlive the server that started them, so the ones left from a
// previous run are stopped on boot instead of running on with nothing owning them.
void reapOrphanPreviews()
  .then(result => { if (result.stopped) app.log.info({ stopped: result.stopped }, "stopped orphan preview containers"); })
  .catch(error => app.log.warn({ error: error instanceof Error ? error.message : error }, "preview reap skipped"));
// A preview nobody uses is stopped after PREVIEW_IDLE_MS (five minutes by default): without
// the sweep every project that was ever previewed would keep a dev server and its memory.
startPreviewSweeper();
