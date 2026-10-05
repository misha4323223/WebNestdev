import type { FastifyInstance } from "fastify";
import { listTools } from "../tool-registry.js";

export async function registerToolRoutes(app:FastifyInstance){
  app.get("/api/tools",async()=>({tools:listTools()}));
}
