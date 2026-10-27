import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";
import { isSameOriginRequest, sameOriginRefusal } from "../security/same-origin.js";
import {
  buildPaymentUrl,
  planPriceRub,
  publicPlans,
  resultSignatureBase,
  robokassaConfig,
  sameSignature,
  signValue,
} from "../billing/robokassa.js";
import {
  createPayment,
  getPayment,
  markPaymentPaid,
  setAutoRenew,
} from "../billing/store.js";
import { autoRenewRefusal, notifyPaymentPaid } from "../billing/notify.js";
import { getDonationByInvoice, markDonationPaid } from "../support/donation-store.js";

/**
 * Оплата подписки через Робокассу.
 *
 * Три двери, и у каждой своя роль:
 *   POST /api/billing/checkout      — браузер просит счёт, сервер отдаёт ссылку на оплату;
 *   POST /api/billing/robokassa/result — Робокасса подтверждает деньги (единственный источник правды);
 *   GET  /api/billing/robokassa/success|fail — браузер возвращается на сайт после оплаты.
 *
 * Возврат в браузере ничего не включает: `SuccessURL` открывается и при отмене на стороне
 * пользователя, поэтому тариф меняет только уведомление с верной подписью по паролю №2.
 */

const checkoutSchema = z.object({
  plan: z.enum(["pro", "team"]),
  /** Отдельное согласие на автопродление; без него счёт разовый. */
  autoRenew: z.boolean().optional(),
});
const renewSchema = z.object({ autoRenew: z.boolean() });

type FormBody = Record<string, string | undefined>;

/**
 * Защита от CSRF для действий с деньгами.
 *
 * В production панель и API живут на одном домене, поэтому проверка Origin обязательна. В
 * разработке панель открыта на порту Vite и ходит в API через прокси: Origin (5173) и Host (8787)
 * там разные по определению, и строгая проверка отвергала бы каждый платёж из локальной панели.
 * Cookie сессии всё равно `SameSite=Lax`, так что межсайтовый POST её не получит.
 */
function crossSiteRefused(request: FastifyRequest) {
  if (process.env.NODE_ENV !== "production") return false;
  return !isSameOriginRequest(request);
}

function publicSiteUrl(request: FastifyRequest) {
  const configured = (process.env.WEBNESTDEV_SITE_DOMAIN ?? "").trim().replace(/\/+$/, "");
  if (configured) return /^https?:\/\//i.test(configured) ? configured : "https://" + configured;
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim().toLowerCase() || request.protocol || "http";
  const host = (Array.isArray(request.headers["x-forwarded-host"]) ? request.headers["x-forwarded-host"][0] : request.headers["x-forwarded-host"]) || request.headers.host || "localhost:8787";
  return proto + "://" + host;
}

/**
 * Робокасса присылает уведомление формой (`application/x-www-form-urlencoded`), а Fastify по
 * умолчанию понимает только JSON. Разбор добавляется здесь, а не новой зависимостью: это несколько
 * строк стандартного `URLSearchParams`.
 */
function registerFormBody(app: FastifyInstance) {
  if (app.hasContentTypeParser("application/x-www-form-urlencoded")) return;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    try {
      done(null, Object.fromEntries(new URLSearchParams(text)) as FormBody);
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}

export async function registerBillingRoutes(app: FastifyInstance) {
  registerFormBody(app);

  /**
   * Счёт на оплату тарифа. Сумма берётся из каталога (или из ключа ROBOKASSA_PRICE_*), а не из
   * запроса: браузер не должен решать, сколько стоит подписка. А вот согласие на автопродление
   * приходит из запроса — это выбор человека, и без него счёт остаётся разовым.
   */
  app.post("/api/billing/checkout", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (crossSiteRefused(request)) return reply.code(403).send({ error: sameOriginRefusal() });
    const parsed = checkoutSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Выберите платный тариф: «Плюс» или «Премиум»" });
    const body = parsed.data;
    const config = robokassaConfig();
    if (!config.configured) {
      return reply.code(503).send({ error: "Оплата пока не подключена. Попробуйте позже." });
    }
    const amount = planPriceRub(body.plan);
    if (!(amount > 0)) return reply.code(409).send({ error: "Для этого тарифа не задана цена" });
    if (body.autoRenew) {
      if (!config.recurring) {
        return reply.code(409).send({ error: "Автопродление сейчас недоступно. Продлить подписку можно вручную после окончания оплаченного периода." });
      }
      // Предупреждение о списании — часть автопродления: без почты включить его нельзя.
      const refusal = await autoRenewRefusal(user);
      if (refusal) return reply.code(409).send({ error: refusal });
    }
    // Отметка на сайте решает две вещи: попадёт ли в платёж `Recurring=true` и включится ли
    // продление у новой подписки. Магазин должен уметь периодические платежи, а согласие — быть.
    const autoRenew = Boolean(body.autoRenew && config.recurring);
    const payment = await createPayment({ userId: user.id, plan: body.plan, amount, autoRenew });
    const plan = PLAN_CATALOG[body.plan];
    const link = buildPaymentUrl({
      config,
      plan: body.plan,
      planName: plan.name,
      invId: payment.invId,
      amount,
      description: "Подписка NestDev «" + plan.name + "», 1 месяц",
      email: user.email,
      recurring: autoRenew,
    });
    request.log.info({ invId: payment.invId, plan: body.plan, amount, test: config.testMode }, "billing: счёт создан");
    return { invId: payment.invId, paymentUrl: link.url, amount, currency: "RUB", test: config.testMode };
  });

  /**
   * Уведомление об успешной оплате. Порядок проверок важен: подпись, затем счёт, затем сумма.
   * `OK{InvId}` — единственный ответ, после которого Робокасса считает платёж доставленным.
   */
  app.post("/api/billing/robokassa/result", async (request, reply) => {
    reply.type("text/plain; charset=utf-8");
    const config = robokassaConfig();
    if (!config.configured) return reply.code(503).send("Payment is not configured");
    const body = (request.body ?? {}) as FormBody;
    const outSum = String(body.OutSum ?? "").trim();
    const invId = Number(body.InvId);
    const signature = String(body.SignatureValue ?? "");
    if (!outSum || !Number.isInteger(invId) || invId <= 0) return reply.code(400).send("Invalid notification");

    const expected = signValue(resultSignatureBase(outSum, invId, config.password2), config.hash);
    if (!sameSignature(expected, signature)) {
      request.log.warn({ invId }, "billing: уведомление с неверной подписью отклонено");
      return reply.code(400).send("Invalid signature");
    }

    // Один и тот же ResultURL принимает и подписки, и добровольные донаты: счёт ищется в обоих
    // хранилищах, иначе оплата поддержки выглядела бы как уведомление о неизвестном счёте.
    const donation = await getDonationByInvoice(invId);
    const payment = donation ? null : await getPayment(invId);
    if (!donation && !payment) {
      request.log.error({ invId }, "billing: уведомление о неизвестном счёте");
      return reply.code(404).send("Unknown invoice");
    }
    // Сравнение сумм, а не строк: тестовый и боевой режимы печатают OutSum по-разному.
    const expectedAmount = donation ? donation.amount : payment!.amount;
    if (Math.abs(Number(outSum) - expectedAmount) > 0.01) {
      request.log.error({ invId, outSum, expected: expectedAmount }, "billing: сумма уведомления не совпала со счётом");
      return reply.code(400).send("Amount mismatch");
    }
    if (donation) {
      await markDonationPaid(invId);
      request.log.info({ invId, userId: donation.userId, amount: donation.amount }, "donation paid");
      return "OK" + invId;
    }
    // Ветка выше уже вернула ответ для доната, значит здесь счёт подписки. Проверка нужна
    // только для типов: без неё TypeScript не знает, что payment найден проверкой выше.
    if (!payment) return reply.code(404).send("Unknown invoice");

    const result = await markPaymentPaid(invId);
    if (result?.alreadyPaid) request.log.info({ invId }, "billing: повторное уведомление, платёж уже закрыт");
    else request.log.info({ invId, plan: payment.plan, userId: payment.userId, until: result?.subscription.renewsAt }, "billing: оплата подтверждена");
    // Письмо об оплате — отдельный шаг после подтверждения денег: Робокасса ждёт `OK`, и отказ
    // почты не должен менять ответ ей. Ошибка письма видна в логе, платёж уже закрыт.
    if (result && !result.alreadyPaid) {
      void notifyPaymentPaid({
        userId: payment.userId,
        plan: payment.plan,
        amount: payment.amount,
        invId,
        renewsAt: result.subscription.renewsAt,
        autoRenew: result.subscription.autoRenew,
      }).then(sent => {
        if (!sent) request.log.info({ invId, userId: payment.userId }, "billing: письмо об оплате не отправлено — у аккаунта нет почты");
      }).catch(error => {
        request.log.error({ invId }, "billing: письмо об оплате не ушло: " + (error instanceof Error ? error.message : String(error)));
      });
    }
    return "OK" + invId;
  });

  /**
   * Возврат браузера. Это только редирект на панель с отметкой: тариф уже включён (или ещё нет)
   * серверным уведомлением, и страница сама перечитает `/api/billing`.
   */
  app.get("/api/billing/robokassa/success", async (request, reply) => {
    const inv = Number((request.query as FormBody | undefined)?.InvId);
    const suffix = Number.isInteger(inv) && inv > 0 ? "&inv=" + inv : "";
    return reply.redirect(publicSiteUrl(request) + "/?payment=success" + suffix);
  });
  app.get("/api/billing/robokassa/fail", async (request, reply) => {
    const inv = Number((request.query as FormBody | undefined)?.InvId);
    const suffix = Number.isInteger(inv) && inv > 0 ? "&inv=" + inv : "";
    return reply.redirect(publicSiteUrl(request) + "/?payment=fail" + suffix);
  });

  /** Автопродление: выключается и включается человеком, а не платежом. */
  app.post("/api/billing/subscription", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    if (crossSiteRefused(request)) return reply.code(403).send({ error: sameOriginRefusal() });
    const body = renewSchema.parse(request.body ?? {});
    const config = robokassaConfig();
    if (body.autoRenew) {
      if (!config.recurring) {
        return reply.code(409).send({ error: "Автопродление сейчас недоступно. Продлить подписку можно вручную после окончания оплаченного периода." });
      }
      // Тот же порядок, что в счёте: продление включается только там, где человека можно предупредить.
      const refusal = await autoRenewRefusal(user);
      if (refusal) return reply.code(409).send({ error: refusal });
    }
    const updated = await setAutoRenew(user.id, body.autoRenew);
    if (!updated) return reply.code(404).send({ error: "Платной подписки нет — сначала оплатите тариф" });
    return { subscription: updated };
  });

  /** Каталог с ценами: интерфейс не хранит суммы у себя. */
  app.get("/api/billing/plans", async () => ({ plans: publicPlans() }));
}

export type { PlanId };
