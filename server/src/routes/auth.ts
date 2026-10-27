import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { attachSession, getCurrentUser, requireUser, SESSION_COOKIE } from "../auth/auth.js";
import { createUser, deleteSession, deleteUserSessions, verifyUser, EMAIL_TAKEN_MESSAGE } from "../auth/auth-store.js";
import { findYandexIdentityByUserId } from "../auth/yandex-account-store.js";
import { findPhoneByUserId, formatPhone } from "../auth/phone-store.js";
import { getUserProfile } from "../account/profile-store.js";
import { checkAuthRateLimit } from "../auth/auth-rate-limit.js";
import { recordAudit } from "../security/audit-journal.js";
import { ACCOUNT_BLOCKED_MESSAGE } from "../account/restriction-store.js";

const credentials = z.object({email:z.string().email().max(200),password:z.string().min(8).max(200)});

export async function registerAuthRoutes(app:FastifyInstance){
  app.get("/api/auth/me", async request => {
    const user = await getCurrentUser(request);
    if (!user) return {authenticated:false,user:null,onboarding:{profile:null}};
    // Which identity opened the account is shown in the profile: a Yandex ID sign-in
    // has no password, and the synthetic address must not look like a real e-mail.
    const [yandex, phone] = await Promise.all([
      findYandexIdentityByUserId(user.id),
      findPhoneByUserId(user.id),
    ]);
    return {
      authenticated:true,
      user:{
        id:user.id,
        email:user.email,
        createdAt:user.createdAt,
        // Телефон отдельно от почты: в служебном адресе …@phone.webnestdev.local
        // он иначе выглядел бы как непонятный email.
        ...(phone ? {phone:formatPhone(phone)} : {}),
        ...(yandex ? {yandex:{login:yandex.login,email:yandex.email??null}} : {}),
      },
      // Контакты знакомства приходят вместе с сессией: по ним интерфейс решает, показывать
      // ли первый экран. Отдельный запрос означал бы мигание главной перед знакомством.
      onboarding:{profile:await getUserProfile(user.id)},
    };
  });
  app.post("/api/auth/register", async (request,reply) => {
    const body = credentials.parse(request.body);
    // Лимит считается и по адресу, и по адресу почты: иначе перебор с разных IP не встречал бы
    // сопротивления, а один счётчик на всех позволял бы блокировать регистрацию целиком.
    const rateLimit = checkAuthRateLimit(request.ip, "register", body.email);
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много попыток регистрации. Попробуйте позже."});
    }
    try{
      const user = await createUser(body.email,body.password);
      await attachSession(reply,user.id,request);
      await recordAudit({
        action: "user.registered",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
      });
      return reply.code(201).send({user:{id:user.id,email:user.email,createdAt:user.createdAt}});
    }catch(error){
      if(error instanceof Error && error.message===EMAIL_TAKEN_MESSAGE) return reply.code(409).send({error:EMAIL_TAKEN_MESSAGE});
      throw error;
    }
  });
  app.post("/api/auth/login", async (request,reply) => {
    const body = credentials.parse(request.body);
    const rateLimit = checkAuthRateLimit(request.ip, "login", body.email);
    if (!rateLimit.allowed) {
      await recordAudit({
        action: "user.login.failed",
        actorType: "system",
        actorId: "",
        actorLabel: body.email,
        ip: request.ip,
        details: { reason: "rate_limited" },
      });
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много попыток входа. Попробуйте позже."});
    }
    const user = await verifyUser(body.email,body.password);
    if(!user) {
      await recordAudit({
        action: "user.login.failed",
        actorType: "system",
        actorId: "",
        actorLabel: body.email,
        ip: request.ip,
        details: { reason: "bad_password" },
      });
      return reply.code(401).send({error:"Неверный email или пароль"});
    }
    // Пароль верный, но аккаунт заблокирован: это не «неверный пароль», и человек должен
    // увидеть причину. В журнал попадает отдельная причина — по ней видно попытки входа.
    if(!(await attachSession(reply,user.id,request))) {
      await recordAudit({
        action: "user.login.failed",
        actorType: "system",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
        details: { reason: "blocked" },
      });
      return reply.code(403).send({error:ACCOUNT_BLOCKED_MESSAGE});
    }
    return {user:{id:user.id,email:user.email,createdAt:user.createdAt}};
  });
  app.post("/api/auth/logout", async (request,reply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if(sessionId) await deleteSession(sessionId);
    reply.clearCookie(SESSION_COOKIE,{path:"/"});
    return {ok:true};
  });
  /**
   * «Выйти на всех устройствах»: один ряд в `sessions` на вход, поэтому отзыв — это удаление
   * всех сессий пользователя. Текущая тоже удаляется: иначе кнопка оставляла бы открытой ту
   * вкладку, с которой её нажали, и «вышли везде» было бы неправдой.
   */
  app.post("/api/auth/logout-all", async (request,reply) => {
    const user = await requireUser(request, reply);
    if(!user) return;
    const revoked = await deleteUserSessions(user.id);
    await recordAudit({
      action: "user.sessions.revoked",
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      ip: request.ip,
      details: { revoked },
    });
    reply.clearCookie(SESSION_COOKIE,{path:"/"});
    return {ok:true,revoked};
  });
}
