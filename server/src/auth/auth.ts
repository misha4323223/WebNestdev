import type { FastifyRequest } from "fastify";
import { createSession, getSession, getUser } from "./auth-store.js";

export const SESSION_COOKIE = "webnestdev_session";

export async function getCurrentUser(request:FastifyRequest){
  const sessionId = request.cookies?.[SESSION_COOKIE];
  if(!sessionId) return null;
  const session = await getSession(sessionId);
  return session ? getUser(session.userId) : null;
}
export async function requireUser(request:FastifyRequest, reply:any){
  const user = await getCurrentUser(request);
  if(!user){
    await reply.code(401).send({error:"Authentication required"});
    return null;
  }
  return user;
}
export async function attachSession(reply:any,userId:string){
  const session = await createSession(userId);
  reply.setCookie(SESSION_COOKIE, session.id, {httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:60*60*24*30});
}
