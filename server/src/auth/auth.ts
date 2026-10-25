import type { FastifyRequest } from "fastify";
import { createSession, getSession, getUser, sessionTtlMs } from "./auth-store.js";
import { getProject, type Project } from "../project-store.js";

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
    await reply.code(401).send({error:"Требуется вход в аккаунт"});
    return null;
  }
  return user;
}
export async function requireProjectUser(request:FastifyRequest, reply:any, projectId:string):Promise<{id:string;email:string}|null>{
  const user=await requireUser(request,reply);
  if(!user)return null;
  const project=await getProject(projectId);
  if(!project||project.userId!==user.id){
    await reply.code(404).send({error:"Проект не найден"});
    return null;
  }
  return user;
}
/**
 * Флаг Secure у cookie сессии — ровно тогда, когда соединение действительно идёт по https.
 *
 * Раньше это решал NODE_ENV: в production флаг ставился всегда. На сервере, открытом по http
 * (например `http://<адрес>:8787`), браузер такую cookie не сохраняет вовсе — код из SMS
 * подходил, а вход «не запоминался», и экран снова просил код. Схема берётся у самого запроса:
 * сначала `X-Forwarded-Proto` (так её сообщает TLS-прокси, см. docs/PRODUCTION_DEPLOYMENT.md),
 * иначе — шифрование сокета. `WEBNESTDEV_COOKIE_SECURE` остаётся жёстким переопределением на
 * случай нестандартной схемы.
 */
export function sessionCookieSecure(request?:FastifyRequest){
  const configured = process.env.WEBNESTDEV_COOKIE_SECURE;
  if (configured !== undefined) return configured === "true";
  const forwarded = request?.headers["x-forwarded-proto"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (value) return value.split(",")[0].trim().toLowerCase() === "https";
  return request?.protocol === "https";
}

// Один раз на процесс, а не на каждый вход: по http cookie идёт без Secure, и это стоит
// увидеть в логе сервера, а не выяснять по «вход не запоминается».
let plainHttpWarned = false;

export async function attachSession(reply:any,userId:string,request?:FastifyRequest){
  const session = await createSession(userId);
  const secure = sessionCookieSecure(request);
  if (!secure && process.env.NODE_ENV === "production" && !plainHttpWarned) {
    plainHttpWarned = true;
    console.warn("[auth] соединение по http: cookie сессии без флага Secure — поставьте TLS перед сервисом (docs/PRODUCTION_DEPLOYMENT.md)");
  }
  // Cookie живёт ровно столько же, сколько разрешён абсолютный срок сессии: idle-таймаут
  // проверяет сервер по отметке активности, а не браузер по сроку cookie.
  reply.setCookie(SESSION_COOKIE, session.id, {httpOnly:true,sameSite:"lax",secure,path:"/",maxAge:Math.max(1,Math.floor(sessionTtlMs()/1000))});
}