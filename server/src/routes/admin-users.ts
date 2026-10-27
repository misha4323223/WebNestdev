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
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";

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
  /** Причина видна администратору в журнале; человеку она не показывается. */
  reason: z.string().trim().min(3).max(500).optional(),
}).strict();
const planSchema = z.object({
  confirm: z.literal(true),
  plan: z.enum(["free", "pro", "team"]),
  /** Срок выдачи; по умолчанию месяц. Больше года одной кнопкой не выдаётся. */
  months: z.number().int().min(1).max(12).optional(),
}).strict();
const tokensSchema = z.object({
  confirm: z.literal(true),
  /** Надбавка к пулу текущего месяца; складывается с уже начисленным. */
  tokens: z.number().int().min(1_000).max(500_000_000),
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
    const subscription = await grantSubscription({ userId: user.id, plan: body.plan as PlanId, months: body.months });
    if (!subscription) {
      // Подписки не было и снимать нечего — это не ошибка запроса, но и записывать в журнал нечего.
      return reply.code(409).send({
        error: body.plan === "free"
          ? "У аккаунта нет действующей подписки — снимать нечего"
          : "Тариф не изменился",
      });
    }
    const plan = await accountPlanFor(user.id);

    await recordAudit({
      action: "user.plan.granted",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: {
        plan: body.plan,
        months: body.months ?? 1,
        previousPlan,
        renewsAt: subscription.renewsAt,
        // Подтверждение, что деньги не спишутся: иначе «компенсация» однажды станет счётом.
        autoRenew: subscription.autoRenew,
      },
    });
    return {
      ok: true,
      plan,
      planName: PLAN_CATALOG[plan].name,
      subscription,
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
    const budget = await getTokenBudget(user.id, plan);

    await recordAudit({
      action: "user.tokens.granted",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      target: user.id,
      ip: request.ip,
      details: { month, tokens: body.tokens, bonusBefore: before, bonusAfter: record.tokens },
    });
    return {
      ok: true,
      month: record.month,
      granted: body.tokens,
      bonus: record.tokens,
      // Пул без надбавки бесполезен: на бесплатном тарифе она не расширяет ничего.
      appliesToPool: budget.limit > budget.bonus,
      budget,
    };
  });
}
