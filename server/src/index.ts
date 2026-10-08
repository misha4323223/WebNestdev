import Fastify from "fastify";
import { ZodError } from "zod";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeStorage, closeStorage } from "./storage/ydb.js";
import { ensureDataDir } from "./project-store.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerPreviewRoutes } from "./routes/preview.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerAgentWebSocket } from "./routes/agent-ws.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerGitHubRoutes } from "./routes/github.js";
import { registerAuthRoutes } from "./routes/auth.js";
import "./tools/project-tools.js";
import "./tools/filesystem-tools.js";
import "./tools/terminal-tools.js";
import "./tools/git-tools.js";
import "./tools/preview-tools.js";
import "./tools/browser-tools.js";

const app=Fastify({logger:true,bodyLimit:2_000_000,requestTimeout:120_000});
const production = process.env.NODE_ENV === "production";
const configuredOrigins = process.env.WEBNESTDEV_ALLOWED_ORIGINS;
if (production && !configuredOrigins) throw new Error("WEBNESTDEV_ALLOWED_ORIGINS is required in production");
const allowedOrigins=(configuredOrigins??"http://localhost:5173").split(",").map(value=>value.trim()).filter(Boolean);
if (production && allowedOrigins.some(origin => /^https?:\/\/localhost(?::\d+)?$/i.test(origin))) {
  throw new Error("localhost is not allowed in WEBNESTDEV_ALLOWED_ORIGINS in production");
}
await ensureDataDir();
await initializeStorage();

app.addHook("onClose", async () => { await closeStorage(); });

app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "Invalid request",
      issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    });
  }
  request.log.error(error);
  if (reply.sent) return;
  return reply.code(500).send({ error: "Internal server error" });
});
await app.register(cors,{origin:(origin,callback)=>{if(!origin||allowedOrigins.includes(origin))callback(null,true);else callback(new Error("Origin not allowed"),false)},credentials:true});
await app.register(cookie);
await app.register(websocket);

await registerHealthRoutes(app);
await registerAuthRoutes(app);
await registerProjectRoutes(app);
await registerPreviewRoutes(app);
await registerToolRoutes(app);
await registerWorkspaceRoutes(app);
await registerProviderRoutes(app);
await registerGitHubRoutes(app);
await registerAgentWebSocket(app);

if (production) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
  await app.register(fastifyStatic, {
    root: rootDir,
    wildcard: false,
    index: false,
    maxAge: "30d",
    immutable: true,
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html", {maxAge: 0, immutable: false}));
  app.get("/*", async (_request, reply) => reply.sendFile("index.html", {maxAge: 0, immutable: false}));
}

await app.listen({host:"0.0.0.0",port:Number(process.env.PORT??8787)});
