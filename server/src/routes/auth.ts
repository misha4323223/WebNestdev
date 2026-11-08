import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { attachSession, getCurrentUser, requireUser, SESSION_COOKIE, SECURE_SESSION_COOKIE } from "../auth/auth.js";
import {
  consumeEmailVerification,
  createUser,
  deleteEmailVerification,
  deletePasswordReset,
  deleteSession,
  deleteUserSessions,
  findEmailVerificationByTokenHash,
  findUserByEmail,
  getEmailVerification,
  getPasswordReset,
  getUser,
  hasLoginPassword,
  hashEmailVerificationToken,
  hashPasswordResetToken,
  markEmailVerified,
  saveEmailVerification,
  savePasswordReset,
  setUserPassword,
  takePasswordReset,
  verifyUser,
  EMAIL_NOT_VERIFIED_MESSAGE,
  EMAIL_TAKEN_MESSAGE,
} from "../auth/auth-store.js";
import { emailVerificationLink, EMAIL_VERIFICATION_TTL_MS, sendVerificationEmail } from "../auth/email-verification-mail.js";
import { passwordResetLink, PASSWORD_RESET_TTL_MS, sendPasswordResetEmail } from "../auth/password-reset-mail.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { originFromRequest } from "../oauth/oauth-flow.js";
import { findYandexIdentityByUserId } from "../auth/yandex-account-store.js";
import { findVkIdentityByUserId } from "../auth/vk-account-store.js";
import { findPhoneByUserId, formatPhone } from "../auth/phone-store.js";
import { getUserProfile } from "../account/profile-store.js";
import { checkAuthRateLimit } from "../auth/auth-rate-limit.js";
import { releaseSignupIp, reserveSignupIp, signupIpExceededMessage } from "../auth/signup-ip.js";
import { recordAudit } from "../security/audit-journal.js";
import { blockedMessageFor, getRestriction } from "../account/restriction-store.js";

const credentials = z.object({email:z.string().email().max(200),password:z.string().min(8).max(200)});
const resendCredentials = z.object({email:z.string().email().max(200)});
const verificationCredentials = z.object({token:z.string().min(32).max(200),password:z.string().min(1).max(200)});
const resetCredentials = z.object({token:z.string().min(32).max(200),password:z.string().min(8,"Пароль должен быть не короче 8 символов").max(200)});
const passwordChange = z.object({
  currentPassword:z.string().min(1).max(200),
  newPassword:z.string().min(8,"Пароль должен быть не короче 8 символов").max(200),
});

/** Тесты подменяют отправку, иначе регистрация пыталась бы открыть настоящее SMTP. */
export type AuthRouteDeps = {
  sendVerificationEmail?: (input:{to:string;link:string}) => Promise<unknown>;
  sendPasswordResetEmail?: (input:{to:string;link:string}) => Promise<unknown>;
  now?: () => number;
};

function resendCooldownMs(){
  const value = Number(process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

/** Отдельная пауза: письмо сброса и письмо подтверждения — разные поводы. */
function passwordResetCooldownMs(){
  const value = Number(process.env.PASSWORD_RESET_RESEND_COOLDOWN_MS);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

/** Публичный адрес приложения: в письме нужна абсолютная ссылка, а не localhost из контейнера. */
function verificationBaseUrl(request:FastifyRequest){
  const configured = getPlatformEnv("PLATFORM_URL")?.trim();
  if(configured) return configured.replace(/\/+$/, "");
  return originFromRequest(request) ?? request.protocol + "://" + (request.headers.host ?? "localhost");
}

/**
 * Выпускает новый одноразовый токен и отправляет письмо. Если отправка не удалась, старая
 * ссылка восстанавливается: сеть или квота Postbox не должны отбирать уже полученный шанс войти.
 */
async function sendEmailVerification(user:{id:string;email:string}, baseUrl:string, now:number, send:(input:{to:string;link:string})=>Promise<unknown>){
  const token = randomBytes(32).toString("hex");
  const previous = await getEmailVerification(user.id);
  await saveEmailVerification({
    userId:user.id,
    tokenHash:hashEmailVerificationToken(token),
    expiresAt:new Date(now + EMAIL_VERIFICATION_TTL_MS).toISOString(),
    sentAt:new Date(now).toISOString(),
  });
  try{
    return await send({to:user.email, link:emailVerificationLink(baseUrl, token)});
  }catch(error){
    try{
      if(previous) await saveEmailVerification(previous);
      else await deleteEmailVerification(user.id);
    }catch{ /* исходная ошибка отправки важнее ошибки отката */ }
    throw error;
  }
}

/**
 * Выпускает новый одноразовый токен сброса и отправляет письмо. Неудачная отправка
 * восстанавливает предыдущий токен: сбой SMTP не должен отбирать уже полученную ссылку.
 */
async function sendPasswordResetToken(user:{id:string;email:string}, baseUrl:string, now:number, send:(input:{to:string;link:string})=>Promise<unknown>){
  const token = randomBytes(32).toString("hex");
  const previous = await getPasswordReset(user.id);
  await savePasswordReset({
    userId:user.id,
    tokenHash:hashPasswordResetToken(token),
    expiresAt:new Date(now + PASSWORD_RESET_TTL_MS).toISOString(),
    sentAt:new Date(now).toISOString(),
  });
  try{
    return await send({to:user.email, link:passwordResetLink(baseUrl, token)});
  }catch(error){
    try{
      if(previous) await savePasswordReset(previous);
      else await deletePasswordReset(user.id);
    }catch{ /* исходная ошибка отправки важнее ошибки отката */ }
    throw error;
  }
}

export async function registerAuthRoutes(app:FastifyInstance, deps:AuthRouteDeps = {}){
  const sendVerification = deps.sendVerificationEmail ?? sendVerificationEmail;
  const sendReset = deps.sendPasswordResetEmail ?? sendPasswordResetEmail;
  const now = deps.now ?? Date.now;
  app.get("/api/auth/me", async request => {
    const user = await getCurrentUser(request);
    if (!user) return {authenticated:false,user:null,onboarding:{profile:null}};
    // Which identity opened the account is shown in the profile: a Yandex ID sign-in
    // has no password, and the synthetic address must not look like a real e-mail.
    const [yandex, vk, phone] = await Promise.all([
      findYandexIdentityByUserId(user.id),
      findVkIdentityByUserId(user.id),
      findPhoneByUserId(user.id),
    ]);
    return {
      authenticated:true,
      user:{
        id:user.id,
        email:user.email,
        createdAt:user.createdAt,
        // Есть ли у аккаунта настоящий пароль: у входа по SMS и через внешние сервисы он
        // случайный, и форма «сменить пароль» им не показывается.
        hasPassword:hasLoginPassword(user.email),
        // Телефон отдельно от почты: в служебном адресе …@phone.webnestdev.local
        // он иначе выглядел бы как непонятный email.
        ...(phone ? {phone:formatPhone(phone)} : {}),
        ...(yandex ? {yandex:{login:yandex.login,email:yandex.email??null}} : {}),
        ...(vk ? {vk:{name:vk.name,email:vk.email??null}} : {}),
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
    const rateLimit = await checkAuthRateLimit(request.ip, "register", body.email);
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много попыток регистрации. Попробуйте позже."});
    }
    // Три аккаунта с адреса — навсегда, а не за сутки: недельное окно обходится регистрацией
    // по одному аккаунту в день, и бесплатный тариф становится бессрочным.
    const ipLimit = await reserveSignupIp(request.ip).catch(error => {
      // Сбой счётчика не должен закрывать регистрацию всем: это защита, а не вход.
      request.log.error({error:error instanceof Error ? error.message : error},"signup ip counter unavailable");
      return null;
    });
    if (ipLimit && !ipLimit.allowed) {
      await recordAudit({
        action: "security.signup.blocked",
        actorType: "system",
        actorId: "signup-ip",
        ip: request.ip,
        details: { limit: ipLimit.limit },
      });
      return reply.code(403).send({error:signupIpExceededMessage(ipLimit.limit),code:"SIGNUP_IP_LIMIT"});
    }
    try{
      let user;
      try{
        user = await createUser(body.email,body.password,{emailVerified:false});
      }catch(error){
        // Аккаунт не создался — место под него освобождается, иначе отказ по занятой почте
        // съедал бы лимит адреса.
        if(ipLimit) await releaseSignupIp(request.ip).catch(()=>undefined);
        throw error;
      }
      const baseUrl = verificationBaseUrl(request);
      try{
        await sendEmailVerification(user,baseUrl,now(),sendVerification);
      }catch(error){
        // Аккаунт остаётся неподтверждённым: после починки почты письмо можно запросить
        // повторно, не создавая второй аккаунт на тот же адрес.
        request.log.error({error:error instanceof Error ? error.message : error},"email verification not sent");
        await recordAudit({
          action: "user.registered",
          actorType: "user",
          actorId: user.id,
          actorLabel: user.email,
          target: user.id,
          ip: request.ip,
          details: { emailVerification: "failed" },
        });
        return reply.code(503).send({
          error: "Аккаунт создан, но письмо подтверждения не ушло. Запросите его повторно после настройки почты.",
          code: "EMAIL_SEND_FAILED",
          email: user.email,
        });
      }
      await recordAudit({
        action: "user.registered",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
        details: { emailVerification: "sent" },
      });
      return reply.code(201).send({verificationRequired:true,email:user.email,expiresInSeconds:Math.floor(EMAIL_VERIFICATION_TTL_MS/1000)});
    }catch(error){
      if(error instanceof Error && error.message===EMAIL_TAKEN_MESSAGE) return reply.code(409).send({error:EMAIL_TAKEN_MESSAGE,code:"EMAIL_TAKEN"});
      throw error;
    }
  });
  /**
   * Ссылка из письма открывает форму в приложении и сама аккаунт не активирует: иначе
   * злоумышленник мог бы зарегистрировать чужой адрес со своим паролем, а получатель письма —
   * случайно подтвердить эту заготовку. Пароль проверяется здесь.
   */
  app.post("/api/auth/verify-email", async (request,reply) => {
    const body = verificationCredentials.parse(request.body);
    const tokenHash = hashEmailVerificationToken(body.token);
    const verification = await findEmailVerificationByTokenHash(tokenHash);
    if(!verification) return reply.code(400).send({error:"Ссылка подтверждения недействительна или уже использована.",code:"VERIFICATION_INVALID"});
    const user = await getUser(verification.userId);
    if(!user) return reply.code(400).send({error:"Ссылка подтверждения недействительна или уже использована.",code:"VERIFICATION_INVALID"});
    const rateLimit = await checkAuthRateLimit(request.ip,"emailVerify",user.email);
    if(!rateLimit.allowed){
      reply.header("Retry-After",String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много попыток подтверждения. Попробуйте позже."});
    }
    if(Date.parse(verification.expiresAt) <= now()){
      await deleteEmailVerification(user.id);
      return reply.code(410).send({error:"Срок ссылки подтверждения истёк. Запросите новое письмо.",code:"VERIFICATION_EXPIRED"});
    }
    // Пароль проверяется до погашения токена: неверная попытка не должна сжигать ссылку.
    if(!(await verifyUser(user.email,body.password))){
      await recordAudit({
        action: "user.login.failed",
        actorType: "system",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
        details: { reason: "email_verification_bad_password" },
      });
      return reply.code(403).send({error:"Неверный пароль от аккаунта.",code:"VERIFICATION_BAD_PASSWORD"});
    }
    const result = await consumeEmailVerification(tokenHash,now());
    if(result.status === "expired") return reply.code(410).send({error:"Срок ссылки подтверждения истёк. Запросите новое письмо.",code:"VERIFICATION_EXPIRED"});
    if(result.status !== "verified") return reply.code(400).send({error:"Ссылка подтверждения недействительна или уже использована.",code:"VERIFICATION_INVALID"});
    if(!(await attachSession(reply,result.user.id,request))){
      return reply.code(403).send({error:blockedMessageFor(await getRestriction(result.user.id)),code:"ACCOUNT_BLOCKED"});
    }
    await recordAudit({
      action: "user.email.verified",
      actorType: "user",
      actorId: result.user.id,
      actorLabel: result.user.email,
      target: result.user.id,
      ip: request.ip,
    });
    return {user:{id:result.user.id,email:result.user.email,createdAt:result.user.createdAt}};
  });
  /** Повторная отправка. Для чужого и уже подтверждённого адреса ответ одинаковый — иначе
   * форма превращалась бы в проверку, зарегистрирован ли человек. */
  app.post("/api/auth/resend-verification", async (request,reply) => {
    const body = resendCredentials.parse(request.body);
    const rateLimit = await checkAuthRateLimit(request.ip,"emailVerification",body.email);
    if(!rateLimit.allowed){
      reply.header("Retry-After",String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много запросов письма. Попробуйте позже."});
    }
    const user = await findUserByEmail(body.email);
    if(!user || user.emailVerified) return {sent:true};
    const existing = await getEmailVerification(user.id);
    const sentAt = existing ? Date.parse(existing.sentAt) : 0;
    const waitMs = Number.isFinite(sentAt) ? sentAt + resendCooldownMs() - now() : 0;
    if(waitMs > 0) return {sent:true,retryAfter:Math.ceil(waitMs/1000)};
    try{
      await sendEmailVerification(user,verificationBaseUrl(request),now(),sendVerification);
    }catch(error){
      request.log.error({error:error instanceof Error ? error.message : error},"email verification not resent");
      return reply.code(503).send({error:"Не удалось отправить письмо. Попробуйте позже.",code:"EMAIL_SEND_FAILED"});
    }
    return {sent:true};
  });
  /**
   * Запрос ссылки восстановления пароля. Ответ всегда одинаковый — иначе форма стала бы
   * проверкой, зарегистрирован ли адрес. Служебные адреса (SMS, Яндекс ID, VK ID, демо)
   * письма не получают: настоящего пароля у них нет.
   *
   * Сбой почты тоже не меняет ответ: человек повторит запрос, а причина останется в логе.
   * `retryAfter` для известного адреса не возвращается по той же причине, что и для чужого.
   */
  app.post("/api/auth/password-reset/request", async (request,reply) => {
    const body = resendCredentials.parse(request.body);
    const rateLimit = await checkAuthRateLimit(request.ip, "passwordReset", body.email);
    if(!rateLimit.allowed){
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много запросов восстановления. Попробуйте позже."});
    }
    const user = await findUserByEmail(body.email);
    if(!user || !hasLoginPassword(user.email)) return {sent:true};
    const existing = await getPasswordReset(user.id);
    const sentAt = existing ? Date.parse(existing.sentAt) : 0;
    if(Number.isFinite(sentAt) && sentAt + passwordResetCooldownMs() > now()) return {sent:true};
    try{
      await sendPasswordResetToken(user, verificationBaseUrl(request), now(), sendReset);
      await recordAudit({
        action: "user.password.reset.requested",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
      });
    }catch(error){
      request.log.error({error:error instanceof Error ? error.message : error},"password reset email not sent");
    }
    return {sent:true};
  });
  /**
   * Новый пароль по ссылке из письма. Токен гасится до записи пароля: ссылка одноразовая, и
   * два одновременных перехода не должны оба сменить пароль. Все старые сессии отзываются —
   * если ссылку открыл не владелец, украденный вход не переживёт сброса.
   *
   * Переход по ссылке доказывает владение адресом, поэтому аккаунт заодно считается
   * подтверждённым: иначе человек сменил бы пароль и всё равно не смог войти.
   */
  app.post("/api/auth/password-reset/confirm", async (request,reply) => {
    const body = resetCredentials.parse(request.body);
    const rateLimit = await checkAuthRateLimit(request.ip,"passwordResetConfirm");
    if(!rateLimit.allowed){
      reply.header("Retry-After",String(rateLimit.retryAfter));
      return reply.code(429).send({error:"Слишком много попыток восстановления. Попробуйте позже."});
    }
    const taken = await takePasswordReset(hashPasswordResetToken(body.token), now());
    if(taken.status === "expired") return reply.code(410).send({error:"Срок ссылки восстановления истёк. Запросите новое письмо.",code:"PASSWORD_RESET_EXPIRED"});
    if(taken.status !== "ok") return reply.code(400).send({error:"Ссылка восстановления недействительна или уже использована.",code:"PASSWORD_RESET_INVALID"});
    if(!(await setUserPassword(taken.userId, body.password))){
      return reply.code(400).send({error:"Ссылка восстановления недействительна или уже использована.",code:"PASSWORD_RESET_INVALID"});
    }
    await markEmailVerified(taken.userId);
    const revoked = await deleteUserSessions(taken.userId);
    const user = await getUser(taken.userId);
    if(!user) return reply.code(400).send({error:"Ссылка восстановления недействительна или уже использована.",code:"PASSWORD_RESET_INVALID"});
    if(!(await attachSession(reply,user.id,request))){
      return reply.code(403).send({error:blockedMessageFor(await getRestriction(user.id)),code:"ACCOUNT_BLOCKED"});
    }
    await recordAudit({
      action: "user.password.reset",
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      target: user.id,
      ip: request.ip,
      details: { revoked },
    });
    return {user:{id:user.id,email:user.email,createdAt:user.createdAt}};
  });
  /**
   * Смена пароля из настроек. Текущий пароль обязателен: одна украденная cookie не должна
   * позволять закрепиться в аккаунте новым паролем. После смены отзываются все сессии, а
   * текущий браузер получает новую — иначе кнопка выкидывала бы человека из его же вкладки.
   */
  app.post("/api/auth/password/change", async (request,reply) => {
    const user = await requireUser(request, reply); if(!user) return;
    const body = passwordChange.parse(request.body);
    if(!hasLoginPassword(user.email)){
      return reply.code(409).send({error:"У аккаунта нет пароля: вход выполняется по телефону или через Яндекс ID / VK ID.",code:"PASSWORD_NOT_SET"});
    }
    if(!(await verifyUser(user.email, body.currentPassword))){
      await recordAudit({
        action: "user.login.failed",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
        details: { reason: "password_change_bad_current" },
      });
      return reply.code(403).send({error:"Текущий пароль неверен.",code:"PASSWORD_MISMATCH"});
    }
    if(body.currentPassword === body.newPassword){
      return reply.code(400).send({error:"Новый пароль совпадает с текущим.",code:"PASSWORD_SAME"});
    }
    if(!(await setUserPassword(user.id, body.newPassword))){
      return reply.code(404).send({error:"Аккаунт не найден",code:"USER_NOT_FOUND"});
    }
    const revoked = await deleteUserSessions(user.id);
    const signedIn = await attachSession(reply, user.id, request);
    await recordAudit({
      action: "user.password.changed",
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      target: user.id,
      ip: request.ip,
      details: { revoked },
    });
    return {ok:true,revoked,signedIn};
  });
  app.post("/api/auth/login", async (request,reply) => {
    const body = credentials.parse(request.body);
    const rateLimit = await checkAuthRateLimit(request.ip, "login", body.email);
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
    // Пароль верный, но почта ещё не подтверждена. Сессию не выдаём: иначе подтверждение
    // адреса было бы формальностью, а аккаунтом можно было бы пользоваться до клика.
    if(!user.emailVerified){
      await recordAudit({
        action: "user.login.failed",
        actorType: "system",
        actorId: user.id,
        actorLabel: user.email,
        target: user.id,
        ip: request.ip,
        details: { reason: "email_unverified" },
      });
      return reply.code(403).send({error:EMAIL_NOT_VERIFIED_MESSAGE,code:"EMAIL_NOT_VERIFIED"});
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
      return reply.code(403).send({error:blockedMessageFor(await getRestriction(user.id))});
    }
    return {user:{id:user.id,email:user.email,createdAt:user.createdAt}};
  });
  app.post("/api/auth/logout", async (request,reply) => {
    const sessionId = request.cookies?.[SECURE_SESSION_COOKIE] ?? request.cookies?.[SESSION_COOKIE];
    if(sessionId) await deleteSession(sessionId);
    reply.clearCookie(SECURE_SESSION_COOKIE,{path:"/",secure:true});
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
    reply.clearCookie(SECURE_SESSION_COOKIE,{path:"/",secure:true});
    reply.clearCookie(SESSION_COOKIE,{path:"/"});
    return {ok:true,revoked};
  });
}
