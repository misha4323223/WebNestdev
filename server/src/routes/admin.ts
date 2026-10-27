import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { checkAuthRateLimit } from "../auth/auth-rate-limit.js";
import {
  bearerToken,
  consumeAdminRecoveryCode,
  createAdminSession,
  deleteAdminSession,
  deleteAdminSessions,
  enableAdminTotp,
  getAdmin,
  getAdminSession,
  setAdminLastTotpStep,
  setAdminRecoveryHashes,
  verifyAdminPassword,
  type AdminUser,
} from "../admin/admin-store.js";
import { createAdminChallenge, dropAdminChallenge, readAdminChallenge, recordAdminChallengeFailure } from "../admin/challenges.js";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, matchTotp, otpauthUri, TOTP_DIGITS, TOTP_PERIOD_SECONDS } from "../admin/totp.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";

/**
 * Вход администратора платформы через API.
 *
 * Отдельное приложение админки не должно пользоваться ни пользовательской сессией, ни cookie
 * панели. Поэтому здесь своя дверь: `Authorization: Bearer <токен>`, который выдаётся только после
 * пароля и кода из аутентификатора. Cookie не ставится и не читается — значит, межсайтовый запрос
 * не может приложить вход автоматически, и CSRF к этим маршрутам неприменим. Это же причина, по
 * которой префикс `/api/admin/` исключён из общего Origin-guard и получает свой CORS-список
 * (`WEBNESTDEV_ADMIN_ORIGINS`): браузерная админка на другом источнике иначе не смогла бы позвать API.
 *
 * Ответы никогда не кэшируются: в них токен и коды восстановления.
 */

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
});
const challengeSchema = z.object({
  challenge: z.string().min(10).max(200),
});
const codeSchema = challengeSchema.extend({
  code: z.string().min(4).max(64),
});
/** Перевыпуск кодов идёт уже с токеном сессии, поэтому пропуск шага здесь не нужен. */
const recoverySchema = z.object({
  code: z.string().min(4).max(64),
});

export const ADMIN_ISSUER_ENV = "ADMIN_TOTP_ISSUER";
const DEFAULT_ISSUER = "NestDev";

/** Имя, которое увидит человек в аутентификаторе рядом с кодом. */
export function adminIssuer() {
  return (process.env[ADMIN_ISSUER_ENV] ?? "").trim() || DEFAULT_ISSUER;
}

/** Сколько живёт пропуск между паролем и кодом — то же значение, что использует challenges.ts. */
function challengeTtlSeconds() {
  const raw = Number(process.env.ADMIN_CHALLENGE_TTL_MS);
  const ttl = Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
  return Math.floor(ttl / 1000);
}

function startReply(reply: FastifyReply) {
  applyNoStoreToReply(reply);
}

/** То, что можно показать клиенту: хеши, секрет и коды восстановления сюда не попадают. */
function publicAdmin(admin: AdminUser) {
  return {
    id: admin.id,
    email: admin.email,
    totpEnabled: Boolean(admin.totpEnabledAt),
    createdAt: admin.createdAt,
  };
}

async function issueSession(admin: AdminUser) {
  const session = await createAdminSession(admin.id);
  return { token: session.token, expiresAt: session.expiresAt, admin: publicAdmin(admin) };
}

export type AdminRequest = { admin: AdminUser; token: string; expiresAt: string };

/**
 * Проверка входа для остальных админ-маршрутов (статистика в admin-analytics.ts).
 * Ответ 401 уже отправлен к этому моменту, поэтому вызывающий просто делает `return`.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AdminRequest | null> {
  startReply(reply);
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    await reply.code(401).send({ error: "Требуется вход администратора" });
    return null;
  }
  const found = await getAdminSession(token);
  if (!found) {
    await reply.code(401).send({ error: "Сессия истекла — войдите заново" });
    return null;
  }
  return { admin: found.admin, token, expiresAt: found.expiresAt };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  /**
   * Шаг 1: пароль. Успех не выдаёт сессию — вместо неё возвращается короткий пропуск и стадия:
   * `enroll` (фактор ещё не подключён) или `verify` (нужен код). Так пароль сам по себе никуда не
   * пускает, даже если он утёк.
   */
  app.post("/api/admin/login", async (request, reply) => {
    startReply(reply);
    const body = loginSchema.parse(request.body);
    const limit = checkAuthRateLimit(request.ip, "adminLogin", body.email);
    if (!limit.allowed) {
      // 429 — не просто отказ: серия таких ответов и есть картина перебора. Пишем её в журнал,
      // но без пароля и без тела запроса.
      await recordAudit({
        action: "admin.login.failed",
        actorType: "system",
        actorId: "",
        actorLabel: body.email,
        ip: request.ip,
        details: { reason: "rate_limited" },
      });
      reply.header("Retry-After", String(limit.retryAfter));
      return reply.code(429).send({ error: "Слишком много попыток входа. Попробуйте позже." });
    }
    const admin = await verifyAdminPassword(body.email, body.password);
    // Один и тот же ответ для неизвестного email и неверного пароля: перечислять администраторов
    // по разнице текстов нельзя.
    if (!admin) {
      await recordAudit({
        action: "admin.login.failed",
        actorType: "system",
        actorId: "",
        actorLabel: body.email,
        ip: request.ip,
        details: { reason: "bad_password" },
      });
      return reply.code(401).send({ error: "Неверный email или пароль" });
    }

    const stage = admin.totpEnabledAt ? "verify" : "enroll";
    await recordAudit({
      action: "admin.login.password",
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      ip: request.ip,
      details: { stage },
    });
    const challenge = createAdminChallenge({ adminId: admin.id, stage });
    return {
      stage,
      challenge,
      email: admin.email,
      totpEnabled: stage === "verify",
      expiresInSeconds: challengeTtlSeconds(),
    };
  });

  /**
   * Шаг 2а: подключение фактора. Секрет выдаётся один раз и живёт в пропуске, а не в базе: пока
   * человек не подтвердил код, записывать нечего. Повторный вызов выдаёт новый секрет — старый
   * пропуск при этом уничтожается, поэтому «две вкладки настройки» не создают два фактора.
   */
  app.post("/api/admin/2fa/setup", async (request, reply) => {
    startReply(reply);
    const body = challengeSchema.parse(request.body);
    const state = readAdminChallenge(body.challenge);
    if (!state || state.stage !== "enroll") {
      return reply.code(401).send({ error: "Шаг входа истёк — начните с пароля" });
    }
    const admin = await getAdmin(state.adminId);
    if (!admin) return reply.code(401).send({ error: "Администратор не найден" });

    const secret = generateTotpSecret();
    dropAdminChallenge(body.challenge);
    const challenge = createAdminChallenge({ adminId: admin.id, stage: "enroll", secret });
    return {
      challenge,
      secret,
      otpauth: otpauthUri({ issuer: adminIssuer(), account: admin.email, secret }),
      issuer: adminIssuer(),
      account: admin.email,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    };
  });

  /**
   * Шаг 2б: подтверждение подключения. Код проверяется по секрету из пропуска; только после этого
   * фактор записывается. Ответ сразу содержит сессию и коды восстановления — единственный раз,
   * когда коды существуют в открытом виде.
   */
  app.post("/api/admin/2fa/enable", async (request, reply) => {
    startReply(reply);
    const body = codeSchema.parse(request.body);
    const state = readAdminChallenge(body.challenge);
    if (!state || state.stage !== "enroll" || !state.secret) {
      return reply.code(401).send({ error: "Шаг входа истёк — начните с пароля" });
    }
    const admin = await getAdmin(state.adminId);
    if (!admin) return reply.code(401).send({ error: "Администратор не найден" });

    const limit = checkAuthRateLimit(request.ip, "adminTotp", admin.email);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return reply.code(429).send({ error: "Слишком много попыток кода. Попробуйте позже." });
    }

    const match = matchTotp(state.secret, body.code);
    if (!match) {
      await recordAudit({
        action: "admin.2fa.failed",
        actorType: "admin",
        actorId: admin.id,
        actorLabel: admin.email,
        ip: request.ip,
        details: { reason: "setup" },
      });
      const attemptsLeft = recordAdminChallengeFailure(body.challenge);
      return reply.code(401).send({
        error: attemptsLeft ? "Код не подошёл. Осталось попыток: " + attemptsLeft : "Слишком много попыток — начните с пароля",
        attemptsLeft,
      });
    }

    const recoveryCodes = generateRecoveryCodes();
    await enableAdminTotp(admin.id, {
      secret: state.secret,
      step: match.step,
      recoveryHashes: recoveryCodes.map(hashRecoveryCode),
    });
    await recordAudit({
      action: "admin.2fa.enabled",
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      ip: request.ip,
      details: { recoveryCodeCount: recoveryCodes.length },
    });
    dropAdminChallenge(body.challenge);
    // Подключение фактора закрывает всё, что было открыто до него.
    await deleteAdminSessions(admin.id);
    const updated = (await getAdmin(admin.id)) ?? admin;
    const session = await issueSession(updated);
    return { ...session, recoveryCodes, recoveryCodesLeft: recoveryCodes.length };
  });

  /**
   * Шаг 2в: обычный вход. Код TOTP или один из кодов восстановления. Код TOTP принимается только
   * новее уже использованного шага, код восстановления удаляется после первого применения.
   */
  app.post("/api/admin/2fa/verify", async (request, reply) => {
    startReply(reply);
    const body = codeSchema.parse(request.body);
    const state = readAdminChallenge(body.challenge);
    if (!state || state.stage !== "verify") {
      return reply.code(401).send({ error: "Шаг входа истёк — начните с пароля" });
    }
    const admin = await getAdmin(state.adminId);
    if (!admin || !admin.totpEnabledAt || !admin.totpSecret) {
      return reply.code(401).send({ error: "У администратора не подключён второй фактор" });
    }

    const limit = checkAuthRateLimit(request.ip, "adminTotp", admin.email);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return reply.code(429).send({ error: "Слишком много попыток кода. Попробуйте позже." });
    }

    const code = body.code.trim();
    const looksLikeTotp = new RegExp("^\\d{" + TOTP_DIGITS + "}$").test(code);
    if (looksLikeTotp) {
      const match = matchTotp(admin.totpSecret, code, { afterStep: admin.lastTotpStep ?? undefined });
      if (!match) {
        await recordAudit({
          action: "admin.2fa.failed",
          actorType: "admin",
          actorId: admin.id,
          actorLabel: admin.email,
          ip: request.ip,
          details: { reason: "totp" },
        });
        const attemptsLeft = recordAdminChallengeFailure(body.challenge);
        return reply.code(401).send({
          error: attemptsLeft ? "Код не подошёл. Осталось попыток: " + attemptsLeft : "Слишком много попыток — начните с пароля",
          attemptsLeft,
        });
      }
      await setAdminLastTotpStep(admin.id, match.step);
      await recordAudit({
        action: "admin.login.success",
        actorType: "admin",
        actorId: admin.id,
        actorLabel: admin.email,
        ip: request.ip,
        details: { method: "totp" },
      });
      dropAdminChallenge(body.challenge);
      return { ...(await issueSession(admin)), usedRecoveryCode: false };
    }

    const remaining = await consumeAdminRecoveryCode(admin.id, code);
    if (remaining === null) {
      await recordAudit({
        action: "admin.2fa.failed",
        actorType: "admin",
        actorId: admin.id,
        actorLabel: admin.email,
        ip: request.ip,
        details: { reason: "recovery" },
      });
      const attemptsLeft = recordAdminChallengeFailure(body.challenge);
      return reply.code(401).send({
        error: attemptsLeft ? "Код не подошёл. Осталось попыток: " + attemptsLeft : "Слишком много попыток — начните с пароля",
        attemptsLeft,
      });
    }
    await recordAudit({
      action: "admin.login.recovery",
      actorType: "admin",
      actorId: admin.id,
      actorLabel: admin.email,
      ip: request.ip,
      details: { recoveryCodesLeft: remaining },
    });
    dropAdminChallenge(body.challenge);
    return { ...(await issueSession(admin)), usedRecoveryCode: true, recoveryCodesLeft: remaining };
  });

  /** Кто вошёл и до какого времени живёт сессия. Дешёвый способ проверить токен после перезапуска. */
  app.get("/api/admin/me", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    return { admin: publicAdmin(auth.admin), session: { expiresAt: auth.expiresAt } };
  });

  /**
   * Новый набор кодов восстановления. Старые перестают работать все сразу: иначе «перевыпуск»
   * оставлял бы в силе коды, которые уже могли быть скопированы.
   */
  app.post("/api/admin/2fa/recovery", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    const body = recoverySchema.parse(request.body);

    const limit = checkAuthRateLimit(request.ip, "adminTotp", auth.admin.email);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfter));
      return reply.code(429).send({ error: "Слишком много попыток кода. Попробуйте позже." });
    }

    const code = body.code.trim();
    if (new RegExp("^\\d{" + TOTP_DIGITS + "}$").test(code)) {
      const match = matchTotp(auth.admin.totpSecret, code, { afterStep: auth.admin.lastTotpStep ?? undefined });
      if (!match) return reply.code(401).send({ error: "Код не подошёл" });
      await setAdminLastTotpStep(auth.admin.id, match.step);
    } else if ((await consumeAdminRecoveryCode(auth.admin.id, code)) === null) {
      return reply.code(401).send({ error: "Код не подошёл" });
    }

    const recoveryCodes = generateRecoveryCodes();
    await setAdminRecoveryHashes(auth.admin.id, recoveryCodes.map(hashRecoveryCode));
    await recordAudit({
      action: "admin.2fa.reissued",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: { recoveryCodeCount: recoveryCodes.length },
    });
    return { recoveryCodes, recoveryCodesLeft: recoveryCodes.length };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    startReply(reply);
    const token = bearerToken(request.headers.authorization);
    if (token) await deleteAdminSession(token);
    return { ok: true };
  });

  /** «Выйти везде»: смена пароля/фактора и потерянное устройство — типичные поводы. */
  app.post("/api/admin/logout-all", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    const revoked = await deleteAdminSessions(auth.admin.id);
    await recordAudit({
      action: "admin.logout.all",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: { revoked },
    });
    return { ok: true, revoked };
  });
}
