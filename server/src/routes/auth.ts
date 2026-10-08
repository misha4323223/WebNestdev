import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { attachSession, getCurrentUser, requireUser, SESSION_COOKIE } from "../auth/auth.js";
import { createUser, createPhoneUser, deleteSession, findUserByPhone, linkPhoneToUser, PhoneAlreadyLinkedError, verifyUser } from "../auth/auth-store.js";
import { checkAuthRateLimit } from "../auth/auth-rate-limit.js";
import { allowPhoneOtpRequest, allowPhoneOtpVerify, normalizeRussianPhone, requestPhoneOtp, verifyPhoneOtp } from "../auth/phone-otp.js";

const credentials = z.object({email:z.string().email().max(200),password:z.string().min(8).max(200)});
const phoneBody = z.object({phone:z.string().min(10).max(30)});
const verifyPhoneBody = phoneBody.extend({code:z.string().regex(/^\d{6}$/)});
function publicUser(user: {id:string;email:string;createdAt:string;phone?:string}) {
  const isPhoneOnly = user.email.endsWith("@phone.webnestdev.invalid");
  return { id:user.id, email:isPhoneOnly ? "" : user.email, phone:user.phone ?? null, createdAt:user.createdAt };
}
function phoneOrNull(value: string) { return normalizeRussianPhone(value); }

export async function registerAuthRoutes(app:FastifyInstance){
  app.get("/api/auth/me", async request => {
    const user = await getCurrentUser(request);
    return {authenticated:Boolean(user),user:user?publicUser(user):null};
  });
  app.post("/api/auth/register", async (request,reply) => {
    const rateLimit = checkAuthRateLimit(request.ip, "register");
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Too many registration attempts. Try again later."});
    }
    const body = credentials.parse(request.body);
    try{
      const user = await createUser(body.email,body.password);
      await attachSession(reply,user.id);
      return reply.code(201).send({user:publicUser(user)});
    }catch(error){
      if(error instanceof Error && error.message==="Email already registered") return reply.code(409).send({error:error.message});
      throw error;
    }
  });
  app.post("/api/auth/login", async (request,reply) => {
    const rateLimit = checkAuthRateLimit(request.ip, "login");
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Too many login attempts. Try again later."});
    }
    const body = credentials.parse(request.body);
    const user = await verifyUser(body.email,body.password);
    if(!user) return reply.code(401).send({error:"Invalid email or password"});
    await attachSession(reply,user.id);
    return {user:publicUser(user)};
  });
  app.post("/api/auth/phone/request", async (request,reply) => {
    const body = phoneBody.parse(request.body);
    const phone = phoneOrNull(body.phone);
    if (!phone) return reply.code(400).send({error:"Введите российский номер в формате +7 900 123-45-67."});
    if (!await allowPhoneOtpRequest(phone, request.ip)) {
      reply.header("Retry-After", "3600");
      return reply.code(429).send({error:"Слишком много запросов кода. Попробуйте позже."});
    }
    try {
      const result = await requestPhoneOtp(phone);
      return {ok:true,resendAfter:result.resendAfter,message:"Если номер указан верно, код будет отправлен SMS."};
    } catch (error) {
      const statusCode = Number((error as {statusCode?:number})?.statusCode);
      if (statusCode === 429) return reply.code(429).send({error:error instanceof Error ? error.message : "Попробуйте позже."});
      request.log.error({err:error},"Phone OTP delivery failed");
      return reply.code(503).send({error:"Не удалось отправить SMS. Попробуйте позже."});
    }
  });
  app.post("/api/auth/phone/verify", async (request,reply) => {
    const body = verifyPhoneBody.parse(request.body);
    const phone = phoneOrNull(body.phone);
    if (!phone) return reply.code(400).send({error:"Введите российский номер в формате +7 900 123-45-67."});
    if (!await allowPhoneOtpVerify(phone, request.ip)) {
      reply.header("Retry-After", "900");
      return reply.code(429).send({error:"Слишком много попыток проверки кода. Попробуйте позже."});
    }
    if (!await verifyPhoneOtp(phone, body.code)) return reply.code(401).send({error:"Код неверен или срок его действия истёк."});
    let user = await findUserByPhone(phone);
    if (!user) {
      try { user = await createPhoneUser(phone); }
      catch (error) {
        user = await findUserByPhone(phone);
        if (!user) throw error;
      }
    }
    await attachSession(reply,user.id);
    return {user:publicUser(user)};
  });
  app.post("/api/auth/phone/link/request", async (request,reply) => {
    const user = await requireUser(request,reply); if (!user) return;
    const body = phoneBody.parse(request.body);
    const phone = phoneOrNull(body.phone);
    if (!phone) return reply.code(400).send({error:"Введите российский номер в формате +7 900 123-45-67."});
    if (!allowPhoneOtpRequest(phone, request.ip)) {
      reply.header("Retry-After", "3600");
      return reply.code(429).send({error:"Слишком много запросов кода. Попробуйте позже."});
    }
    try {
      const result = await requestPhoneOtp(phone);
      return {ok:true,resendAfter:result.resendAfter,message:"Если номер указан верно, код будет отправлен SMS."};
    } catch (error) {
      const statusCode = Number((error as {statusCode?:number})?.statusCode);
      if (statusCode === 429) return reply.code(429).send({error:error instanceof Error ? error.message : "Попробуйте позже."});
      request.log.error({err:error},"Phone link OTP delivery failed");
      return reply.code(503).send({error:"Не удалось отправить SMS. Попробуйте позже."});
    }
  });
  app.post("/api/auth/phone/link/verify", async (request,reply) => {
    const user = await requireUser(request,reply); if (!user) return;
    const body = verifyPhoneBody.parse(request.body);
    const phone = phoneOrNull(body.phone);
    if (!phone) return reply.code(400).send({error:"Введите российский номер в формате +7 900 123-45-67."});
    if (!allowPhoneOtpVerify(phone, request.ip)) {
      reply.header("Retry-After", "900");
      return reply.code(429).send({error:"Слишком много попыток проверки кода. Попробуйте позже."});
    }
    if (!await verifyPhoneOtp(phone, body.code)) return reply.code(401).send({error:"Код неверен или срок его действия истёк."});
    try {
      await linkPhoneToUser(phone,user.id);
      return {ok:true,phone};
    } catch (error) {
      if (error instanceof PhoneAlreadyLinkedError) return reply.code(409).send({error:"Этот номер уже привязан к другому аккаунту."});
      throw error;
    }
  });
  app.post("/api/auth/logout", async (request,reply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if(sessionId) await deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE,{path:"/"});
    return {ok:true};
  });
}
