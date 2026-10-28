import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { allocateInvoiceId } from "../billing/store.js";
import { buildPaymentUrl, robokassaConfig } from "../billing/robokassa.js";
import { reachableEmailFor } from "../billing/notify.js";
import { createDonation } from "../support/donation-store.js";

/**
 * Добровольная поддержка проекта.
 *
 * Сумму выбирает человек, но проверяет сервер: донат не должен превращаться в способ прислать
 * отрицательное число или миллион. Сообщение необязательно и хранится вместе с донатом — почтовый
 * сервис, который будет его доставлять, появится позже, и данные к этому моменту уже на месте.
 *
 * Если Робокасса настроена, ответ несёт ссылку на оплату; если нет — донат сохраняется со статусом
 * `recorded`, а окно честно говорит, что платёж ещё не подключён.
 */
const donationBody = z.object({
  amount: z.number().int().min(100).max(100_000),
  message: z.string().trim().max(1200).optional(),
});

/** Ограничение на пользователя: донат — не канал для потока сообщений. */
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 5;
const recent = new Map<string, number[]>();

function allowDonation(userId: string) {
  const now = Date.now();
  if (recent.size > 10_000) {
    for (const [key, times] of recent) {
      if (!times.some(time => now - time < WINDOW_MS)) recent.delete(key);
    }
  }
  const kept = (recent.get(userId) ?? []).filter(time => now - time < WINDOW_MS);
  if (kept.length >= LIMIT) {
    recent.set(userId, kept);
    return Math.max(1, Math.ceil((kept[0] + WINDOW_MS - now) / 1000));
  }
  kept.push(now);
  recent.set(userId, kept);
  return 0;
}

export async function registerDonationRoutes(app: FastifyInstance) {
  app.post("/api/donations", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const retryAfter = allowDonation(user.id);
    if (retryAfter) {
      reply.header("Retry-After", String(retryAfter));
      return reply.code(429).send({ error: "Слишком много попыток подряд — попробуйте через несколько минут" });
    }
    const body = donationBody.parse(request.body ?? {});
    const config = robokassaConfig();
    let invId: number | null = null;
    let paymentUrl: string | null = null;
    if (config.configured) {
      invId = await allocateInvoiceId();
      // Служебный адрес входа (`…@phone.webnestdev.local`) — не почта: чек туда не дойдёт.
      // Берём настоящий контакт из профиля, иначе поле Email не передаём вовсе.
      const email = await reachableEmailFor(user);
      const link = buildPaymentUrl({
        config,
        plan: "free",
        planName: "Поддержка проекта",
        invId,
        amount: body.amount,
        description: "Добровольная поддержка проекта NestDev",
        ...(email ? { email } : {}),
        kind: "donation",
      });
      paymentUrl = link.url;
    }
    const donation = await createDonation({
      userId: user.id,
      email: user.email,
      amount: body.amount,
      message: body.message ?? "",
      invId,
    });
    request.log.info({ donation: donation.id, amount: donation.amount, invId, paid: Boolean(paymentUrl) }, "donation recorded");
    return reply.code(201).send({
      ok: true,
      id: donation.id,
      status: donation.status,
      amount: donation.amount,
      paymentUrl,
    });
  });
}
