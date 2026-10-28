import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { deleteUserSessions, getUser } from "../auth/auth-store.js";
import { blockUser, getRestriction, unblockUser } from "../account/restriction-store.js";
import { addTokenBonus, tokenBonusFor, tokenMonth } from "../account/token-bonus.js";
import { accountPlanFor, grantSubscription } from "../billing/store.js";
import { getTokenBudget } from "../account/usage-store.js";
import { createNotification } from "../account/notification-store.js";
import type { PlanId } from "../account/plans.js";
import { planDisplayName } from "../billing/plan-settings.js";

/**
 * Действия администратора над аккаунтом: завершить сеансы, заблокировать, сменить тариф,
 * начислить токены.
 *
 * До этого админка только читала: проблему было видно, а сделать с ней ничего нельзя. Здесь
 * каждое действие отвечает на один вопрос и не пытается делать два: «отозвать сеансы» не блокирует
 * аккаунт, «заблокировать» отзывает сеансы отдельно (и говорит об этом в ответе).
 *
 * Правила одинаковы для всех маршрутов:
 *  • `confirm: true` обязателен и схема тела строгая — запрос с лишним полем получает 400, а не
 *    «удалить заодно и это»;
 *  • цель обязана существовать (404), иначе админка меняла бы записи несуществующих аккаунтов;
 *  • событие пишется в журнал безопасности вместе с id администратора — действие, меняющее
 *    доступ живому человеку, должно читаться постфактум.
 *
 * Администраторы живут в отдельной таблице (admin/admin-store.ts, `admin_users`), а не в `users`,
 * поэтому заблокировать сам себя администратор структурно не может: идентификаторы из разных
 * пространств. Проверка на совпадение с `auth.admin.id` всё равно оставлена — это дешёвая
 * страховка на случай, если когда-нибудь появится вход администратора пользовательской сессией.
 */

const paramsSchema = z.object({ id: z.string().min(1).max(100) });
const confirmOnly = z.object({ confirm: z.literal(true) }).strict();
const blockSchema = z.object({
  confirm: z.literal(true),
  /** Причина попадает в журнал и в сообщение о блокировке при входе. */
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
const planSchema = z.object({
  confirm: z.literal(true),
  plan: z.enum(["free", "pro", "team"]),
  /** Срок выдачи; по умолчанию месяц. Больше года одной кнопкой не выдаётся. */
  months: z.number().int().min(1).max(12).optional(),
  /** Короткая выдача в днях — для компенсации «плюс один день». */
  days: z.number().int().min(1).max(366).optional(),
  /** Показать человеку уведомление в аккаунте; по умолчанию действие молчаливое. */
  notify: z.boolean().optional(),
}).strict().refine(value => !(value.months !== undefined && value.days !== undefined), {
  message: "Укажите либо months, либо days, а не оба",
});
const tokensSchema = z.object({
  confirm: z.literal(true),
  /** Надбавка к пулу текущего месяца; складывается с уже начисленным. */
  tokens: z.number().int().min(1_000).max(500_000_000),
  notify: z.boolean().optional(),
}).strict();

const CONFIRM_REQUIRED = { error: "Нужно подтверждение: { confirm: true }" };
const SELF_BLOCKED = { error: "Свой аккаунт заблокировать нельзя" };

async function targetUser(request: FastifyRequest, reply: FastifyReply) {
  const params = paramsSchema.parse(request.params);
  const user = await getUser(params.id);
  if (!user) {
    await reply.code(404).send({ error: "Пользователь не найден" });
    return null;
  }
  return user;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T | null {
  const parsed = schema.safeParse(body ?? {});
  return parsed.success ? parsed.data : null;
}

/** «500 000» — сумма в уведомлении читается, а не считается разрядами глазами. */
function numberLabel(value: number) {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Русское склонение для срока: 1 день, 3 дня, 5 дней. */
function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function periodLabel(months: number, days?: number) {
  if (days !== undefined) return days + " " + plural(days, "день", "дня", "дней");
  return months + " " + plural(months, "месяц", "месяца", "месяцев");
}

/**
 * Уведомление пишется после самого действия и не отменяет его: если хранилище уведомлений
 * недоступно, человек всё равно получит тариф или токены, а админка увидит `notified: false`.
 */
async function notify(userId: string, input: Omit<Parameters<typeof createNotification>[0], "userId">): Promise<boolean> {
  try {
    await createNotification({ ...input, userId });
    return true;
  } catch (error) {
    console.error("[admin] не удалось создать уведомление для " + userId, error);
    return false;
  }
}

export async function registerAdminUserActionRoutes(app: FastifyInstance) {
  /**
   * Завершить все сеансы. Блокировка не нужна: человек сможет войти заново, но украденная
   * cookie перестанет работать уже сейчас — это и есть смысл действия.
   */
  app.post("/api/admin/users/:id/sessions/revoke", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const user = await targetUser(request, reply);
    if (!user) return;
    if (!parseBody(confirmOnly, request.body)) return reply.code(400).send(CONFIRM_REQUIRED);

    const revoked = await deleteUserSessions(user.id);
    await recordAudit({
      action: "user.sessions.revoked.admin",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: { revoked },
    });
    return { ok: true, revoked };
  });

  /**
   * Блокировка: запрещает вход (все четыре входа проверяют её в attachSession) и отзывает уже
   * выданные сессии. Данные и тариф не трогаются — действие обратимо и не должно ничего терять.
   */
  app.post("/api/admin/users/:id/block", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const params = paramsSchema.parse(request.params);
    if (params.id === auth.admin.id) return reply.code(400).send(SELF_BLOCKED);

    const user = await getUser(params.id);
    if (!user) return reply.code(404).send({ error: "Пользователь не найден" });

    const body = parseBody(blockSchema, request.body);
    if (!body) return reply.code(400).send(CONFIRM_REQUIRED);

    const blocked = await blockUser({
      userId: user.id,
      reason: body.reason ?? "Блокировка администратором",
      adminId: auth.admin.id,
      adminLabel: auth.admin.email,
    });
    // Сеансы отзываются после записи блокировки: даже если второй шаг упадёт, вход уже закрыт.
    const revoked = await deleteUserSessions(user.id);

    await recordAudit({
      action: "user.blocked",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: { reason: blocked.reason, revoked },
    });
    return { ok: true, blocked, revoked };
  });

  /** Снять блокировку. Сеансы не восстанавливаются: человек входит заново. */
  app.post("/api/admin/users/:id/unblock", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const user = await targetUser(request, reply);
    if (!user) return;
    if (!parseBody(confirmOnly, request.body)) return reply.code(400).send(CONFIRM_REQUIRED);

    const wasBlocked = await unblockUser(user.id);
    await recordAudit({
      action: "user.unblocked",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: { wasBlocked },
    });
    return { ok: true, wasBlocked };
  });

  /** Текущее состояние блокировки: админке нужно показать кнопку «снять», а не угадывать. */
  app.get("/api/admin/users/:id/restriction", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const user = await targetUser(request, reply);
    if (!user) return;
    const restriction = await getRestriction(user.id);
    return { blocked: Boolean(restriction), restriction };
  });

  /**
   * Тариф без оплаты: поддержка, компенсация за сбой, проверка тарифа на себе. Автопродление
   * выключается записью (см. grantSubscription), поэтому выданный тариф не превращается в
   * выставленный счёт. `plan: "free"` — снять подписку сейчас, не дожидаясь срока.
   */
  app.post("/api/admin/users/:id/plan", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const user = await targetUser(request, reply);
    if (!user) return;
    const body = parseBody(planSchema, request.body);
    if (!body) return reply.code(400).send({ error: "Нужно подтверждение: { confirm: true, plan: \"free\" | \"pro\" | \"team\" }" });

    const previousPlan = await accountPlanFor(user.id);
    const subscription = await grantSubscription({
      userId: user.id,
      plan: body.plan as PlanId,
      months: body.months,
      days: body.days,
    });
    if (!subscription) {
      // Подписки не было и снимать нечего — это не ошибка запроса, но и записывать в журнал нечего.
      return reply.code(409).send({
        error: body.plan === "free"
          ? "У аккаунта нет действующей подписки — снимать нечего"
          : "Тариф не изменился",
      });
    }
    const plan = await accountPlanFor(user.id);
    // Срок — то, что нужно админке для подтверждения действия; без него карточка не может
    // отличить «тариф тот же» от «день действительно добавился».
    const planUntil = subscription.renewsAt;
    const message = body.plan === "free"
      ? "Подписка завершена администратором"
      : "Вам активировали «" + planDisplayName(body.plan) + "» на " + periodLabel(body.months ?? 1, body.days);
    const notified = body.notify
      ? await notify(user.id, {
          kind: "plan",
          message,
          plan: body.plan as PlanId,
          planUntil,
        })
      : false;

    await recordAudit({
      action: "user.plan.granted",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: {
        userId: user.id,
        plan: body.plan,
        months: body.months ?? (body.days === undefined ? 1 : 0),
        days: body.days ?? 0,
        previousPlan,
        planUntil,
        // Подтверждение, что деньги не спишутся: иначе «компенсация» однажды станет счётом.
        autoRenew: subscription.autoRenew,
        message,
      },
    });
    return {
      ok: true,
      plan,
      planName: planDisplayName(plan),
      planUntil,
      message,
      subscription,
      notified,
    };
  });

  /**
   * Начисление токенов на текущий месяц. Это надбавка к пулу тарифа, а не правка расхода:
   * расход по-прежнему считается по `model_usage` и остаётся честным.
   */
  app.post("/api/admin/users/:id/tokens", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const user = await targetUser(request, reply);
    if (!user) return;
    const body = parseBody(tokensSchema, request.body);
    if (!body) return reply.code(400).send({ error: "Нужно подтверждение: { confirm: true, tokens: <целое> }" });

    const month = tokenMonth();
    const before = await tokenBonusFor(user.id, month);
    const record = await addTokenBonus(user.id, body.tokens);
    const plan = await accountPlanFor(user.id);
    // Пул читается после записи: `tokens` в ответе — новый доступный остаток, а не сумма выдачи.
    const budget = await getTokenBudget(user.id, plan);
    const message = "Начислено " + numberLabel(body.tokens) + " токенов";
    const notified = body.notify
      ? await notify(user.id, { kind: "gift", message, tokens: body.tokens })
      : false;

    await recordAudit({
      action: "user.tokens.granted",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: {
        userId: user.id,
        month,
        tokens: body.tokens,
        balanceAfter: budget.remaining,
        bonusBefore: before,
        bonusAfter: record.tokens,
        message,
      },
    });
    return {
      ok: true,
      // Новый баланс доступных токенов на текущий месяц: админка показывает его человеку.
      tokens: budget.remaining,
      message,
      month: record.month,
      granted: body.tokens,
      bonus: record.tokens,
      // Пул без надбавки бесполезен: на бесплатном тарифе она не расширяет ничего.
      appliesToPool: budget.limit > budget.bonus,
      budget,
      notified,
    };
  });
}
