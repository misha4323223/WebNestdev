import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { attachSession } from "../auth/auth.js";
import { checkAuthRateLimit } from "../auth/auth-rate-limit.js";
import { demoPhone, ensurePhoneAccount, formatPhone, normalizePhone, startPhoneLogin, verifyPhoneCode } from "../auth/phone-store.js";
import { sendLoginCode, smsConfig, smsConfigHint, smsProviderLabel } from "../auth/sms.js";

const phoneInput = z.object({ phone: z.string().min(1).max(30) });
const verifyInput = z.object({ phone: z.string().min(1).max(30), code: z.string().min(1).max(10) });

/**
 * Enter a phone number, receive a code from a Russian SMS provider, get a session.
 * Without provider credentials the server runs in test mode and logs the code instead
 * of sending it, so the flow can be tested before the account at the provider exists.
 */
export async function registerPhoneAuthRoutes(app: FastifyInstance) {
  // Public on purpose: the sign-in screen asks which provider is available before
  // anybody is authenticated. It exposes no credentials, only the provider's name.
  app.get("/api/auth/phone/status", async () => {
    const config = smsConfig();
    const demo = demoPhone();
    return {
      provider: config.provider,
      providerLabel: smsProviderLabel(config.provider),
      configured: Boolean(config.provider),
      testMode: config.test,
      sender: config.sender,
      hint: smsConfigHint(),
      // The demo number is shown on the sign-in screen so it can be used instead of SMS.
      ...(demo ? { demoPhone: formatPhone(demo) } : {}),
    };
  });

  app.post("/api/auth/phone/start", async (request, reply) => {
    const body = phoneInput.parse(request.body ?? {});
    const phone = normalizePhone(body.phone);
    if (!phone) return reply.code(400).send({ error: "Введите российский номер телефона, например +7 999 123-45-67" });

    const demo = demoPhone();
    const isDemo = demo !== null && phone === demo;
    const rateLimit = checkAuthRateLimit(request.ip, isDemo ? "phoneDemo" : "phone");
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({ error: "Слишком много запросов кода. Попробуйте позже." });
    }

    // The demo number is let straight in: no code, no SMS, an ordinary session.
    if (isDemo) {
      const user = await ensurePhoneAccount(phone);
      await attachSession(reply, user.id);
      return {
        sent: true,
        demo: true,
        phone: formatPhone(phone),
        provider: "demo",
        providerLabel: "демо-номер",
        testMode: true,
        expiresInSeconds: 0,
        user: { id: user.id, email: user.email, createdAt: user.createdAt },
      };
    }

    const started = startPhoneLogin(phone);
    if (!started.ok) {
      reply.header("Retry-After", String(started.retryAfterSeconds));
      return reply.code(429).send({ error: started.error, retryAfterSeconds: started.retryAfterSeconds });
    }

    const delivery = await sendLoginCode(phone, started.code);
    if (!delivery.ok) {
      return reply.code(502).send({ error: "Не удалось отправить SMS: " + (delivery.error ?? "провайдер отклонил запрос"), providerLabel: delivery.providerLabel });
    }
    const config = smsConfig();
    return {
      sent: true,
      phone: formatPhone(phone),
      provider: delivery.provider,
      providerLabel: delivery.providerLabel,
      testMode: delivery.test,
      expiresInSeconds: started.expiresInSeconds,
      // Only a test-mode development server hands the code back; production never does.
      ...(delivery.test && process.env.NODE_ENV !== "production" ? { devCode: started.code } : {}),
      ...(config.test ? { notice: config.provider ? "Тестовый режим: SMS не отправляется, код виден в логах сервера." : "SMS-провайдер не подключён: код виден в логах сервера." } : {}),
    };
  });

  app.post("/api/auth/phone/verify", async (request, reply) => {
    const rateLimit = checkAuthRateLimit(request.ip, "phoneVerify");
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfter));
      return reply.code(429).send({ error: "Слишком много попыток. Попробуйте позже." });
    }
    const body = verifyInput.parse(request.body ?? {});
    const phone = normalizePhone(body.phone);
    if (!phone) return reply.code(400).send({ error: "Введите российский номер телефона" });

    const checked = verifyPhoneCode(phone, body.code);
    if (!checked.ok) return reply.code(401).send({ error: checked.error });

    const user = await ensurePhoneAccount(phone);
    await attachSession(reply, user.id);
    return { user: { id: user.id, email: user.email, createdAt: user.createdAt } };
  });
}
