import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
import "./tools/verification-tools.js";

const app=Fastify({logger:true});
const allowedOrigins=(process.env.WEBNESTDEV_ALLOWED_ORIGINS??"http://localhost:5173").split(",").map(value=>value.trim()).filter(Boolean);
await ensureDataDir();
await app.register(cors,{origin:(origin,callback)=>{if(!origin||allowedOrigins.includes(origin))callback(null,true);else callback(new Error("Origin not allowed"),false)},credentials:true});
await app.register(cookie);
await app.register(websocket);

const webRoot=resolve(process.cwd(),"dist");
if (existsSync(webRoot)) {
  await app.register(fastifyStatic,{root:webRoot,index:"index.html",wildcard:false});
}

await registerHealthRoutes(app);
await registerAuthRoutes(app);
await registerProjectRoutes(app);
await registerPreviewRoutes(app);
await registerToolRoutes(app);
await registerWorkspaceRoutes(app);
await registerProviderRoutes(app);
await registerGitHubRoutes(app);
await registerAgentWebSocket(app);

if (existsSync(webRoot)) {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api") || request.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    const accept=String(request.headers.accept??"");
    if (accept.includes("text/html")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });
}

await app.listen({host:"0.0.0.0",port:Number(process.env.PORT??8787)});
