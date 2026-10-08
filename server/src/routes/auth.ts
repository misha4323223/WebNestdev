import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { attachSession, getCurrentUser, SESSION_COOKIE } from "../auth/auth.js";
import { createUser, deleteSession, verifyUser } from "../auth/auth-store.js";
import { checkAuthRateLimit } from "../auth/auth-rate-limit.js";

const credentials = z.object({email:z.string().email().max(200),password:z.string().min(8).max(200)});

export async function registerAuthRoutes(app:FastifyInstance){
  app.get("/api/auth/me", async request => {
    const user = await getCurrentUser(request);
    return {authenticated:Boolean(user),user:user?{id:user.id,email:user.email,createdAt:user.createdAt}:null};
  });
  app.post("/api/auth/register", async (request,reply) => {
    const body = credentials.parse(request.body);
    try{
      const user = await createUser(body.email,body.password);
      await attachSession(reply,user.id);
      return reply.code(201).send({user:{id:user.id,email:user.email,createdAt:user.createdAt}});
    }catch(error){
      if(error instanceof Error && error.message==="Email already registered") return reply.code(409).send({error:error.message});
      throw error;
    }
  });
  app.post("/api/auth/login", async (request,reply) => {
    const body = credentials.parse(request.body);
    const user = await verifyUser(body.email,body.password);
    if(!user) return reply.code(401).send({error:"Invalid email or password"});
    await attachSession(reply,user.id);
    return {user:{id:user.id,email:user.email,createdAt:user.createdAt}};
  });
  app.post("/api/auth/logout", async (request,reply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if(sessionId) await deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE,{path:"/"});
    return {ok:true};
  });
}
