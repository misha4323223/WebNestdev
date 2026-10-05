import type { FastifyInstance } from "fastify";
import { sandboxStatus } from "../docker-sandbox.js";

export async function registerHealthRoutes(app:FastifyInstance){
  app.get("/api/health",async()=>({ok:true,service:"webnestdev-server",sandbox:await sandboxStatus()}));
  app.get("/api/sandbox/status",async()=>sandboxStatus());
}
