import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getCurrentUser, requireUser } from "../auth/auth.js";
import { bearerToken, getAdminSession } from "../admin/admin-store.js";
import { isPlatformAdmin } from "../platform/admin.js";
import { createSupportTicket, getSupportTicket, listSupportTickets, readSupportScreenshot, supportTicketsForUser, type SupportReporter } from "../support/support-store.js";
import { loadSupportUser, supportReporterFor, supportReporterFrom } from "../support/support-user.js";
import { sendSupportMail, supportMailSettings } from "../support/support-mail.js";
import { supportApiKey, supportKeyAuthorizedCurrent, supportKeyFromHeaders, supportKeySource } from "../support/support-api-key.js";
import { applyNoStoreToReply } from "./cache-headers.js";

/**
 * Обращение в поддержку: категория, важность, описание, шаги воспроизведения и обязательный
 * скриншот. Текст проверяется по длине, картинка — по сигнатуре файла в хранилище, поэтому
 * сюда нельзя прислать что-то кроме PNG/JPEG/WebP.
 */
const ticketBody = z.object({
  category: z.enum(["bug", "idea"]),
  severity: z.number().int().min(1).max(10),
  description: z.string().trim().min(10).max(4000),
  steps: z.string().trim().max(4000).optional(),
  context: z.string().trim().max(4000).optional(),
  page: z.string().trim().max(500).optional(),
  projectId: z.string().trim().max(100).optional(),
  screenshot: z.string().min(64).max(8_000_000),
});

/** Ограничение на пользователя: поддержка — не канал для потоковых сообщений. */
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 5;
const recent = new Map<string, number[]>();

function allowTicket(userId: string) {
  const now = Date.now();
  // Карта живёт вместе с процессом: старые записи убираются, чтобы она не росла с числом аккаунтов.
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

/**
 * Кто читает обращения. Три двери: администратор платформы в браузере (cookie сессии), внешняя
 * админка по своей админ-сессии (`Authorization: Bearer`) и клиент по ключу чтения
 * (`X-Support-Key` или `Authorization: Bearer`). Все три дают только чтение: создание обращения
 * по-прежнему требует пользовательской сессии.
 */
async function allowTicketRead(request: FastifyRequest, reply: FastifyReply) {
  if (await supportKeyAuthorizedCurrent(request.headers)) return true;

  // Админ-приложение уже вошло по паролю и TOTP. Его сессия — такая же дверь, как ключ:
  // отдельный общий секрет не нужен, а срок и бездействие проверяются как в остальной админке.
  // Cookie здесь не принимается — только Authorization, поэтому CSRF-барьер не ослабляется.
  const adminToken = bearerToken(request.headers.authorization);
  if (adminToken) {
    try {
      if (await getAdminSession(adminToken)) return true;
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.message : error }, "admin session check failed for support read");
    }
  }

  const providedKey = supportKeyFromHeaders(request.headers);
  const user = await getCurrentUser(request);
  if (!user) {
    // Заголовок объясняет отказ без раскрытия значения: клиент видит, настроен ли ключ на этом
    // процессе и совпал ли он, вместо одинакового 401 на все случаи.
    reply.header("X-Support-Auth", providedKey ? (supportApiKey() ? "key-mismatch" : "key-not-configured") : "session-required");
    request.log.info({
      supportKey: providedKey ? (supportApiKey() ? "mismatch" : "not-configured") : "absent",
      supportKeySource: supportKeySource(),
      adminToken: adminToken ? "not-a-session" : "absent",
    }, "support read refused");
    await reply.code(401).send({ error: "Требуется вход в аккаунт" });
    return false;
  }
  if (!isPlatformAdmin(user)) {
    await reply.code(403).send({ error: "Раздел доступен только администратору платформы" });
    return false;
  }
  return true;
}

export async function registerSupportRoutes(app: FastifyInstance) {
  app.post("/api/support", { bodyLimit: 8_000_000 }, async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    const retryAfter = allowTicket(user.id);
    if (retryAfter) {
      reply.header("Retry-After", String(retryAfter));
      return reply.code(429).send({ error: "Слишком много обращений подряд — попробуйте через несколько минут" });
    }
    const body = ticketBody.parse(request.body);
    applyNoStoreToReply(reply);
    // Карточка автора — вспомогательная: если хранилище профиля недоступно, обращение всё равно
    // должно сохраниться и попасть в админку.
    let reporter: SupportReporter | undefined;
    try {
      reporter = await supportReporterFor(user.id) ?? undefined;
    } catch (error) {
      request.log.warn(
        { error: error instanceof Error ? error.message : error },
        "support reporter snapshot failed",
      );
    }
    try {
      const ticket = await createSupportTicket({
        userId: user.id,
        email: user.email,
        category: body.category,
        severity: body.severity,
        description: body.description,
        steps: body.steps || undefined,
        context: body.context || undefined,
        page: body.page || undefined,
        projectId: body.projectId || undefined,
        userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"].slice(0, 300) : undefined,
        ip: request.ip.slice(0, 100),
        ...(reporter ? { reporter } : {}),
        screenshot: body.screenshot,
      });
      request.log.info({ supportTicket: ticket.id, category: body.category, severity: body.severity }, "support ticket created");
      // Письмо — отдельный шаг: тикет уже сохранён, и отказ почты не должен выглядеть как
      // «обращение не отправлено». Состояние доставки возвращается в ответе, чтобы окно сказало
      // правду: «ушло на почту» или «сохранено, почта не настроена».
      const settings = supportMailSettings();
      let notified = false;
      if (settings) {
        try {
          const shot = await readSupportScreenshot(ticket.id);
          await sendSupportMail(settings, {
            id: ticket.id,
            category: body.category,
            severity: body.severity,
            email: user.email,
            description: body.description,
            createdAt: ticket.createdAt,
            ...(body.steps ? { steps: body.steps } : {}),
            ...(body.context ? { context: body.context } : {}),
            ...(body.page ? { page: body.page } : {}),
            ...(body.projectId ? { projectId: body.projectId } : {}),
            ip: request.ip.slice(0, 100),
            ...(reporter ? { reporter } : {}),
          }, shot);
          notified = true;
        } catch (error) {
          request.log.error(
            { supportTicket: ticket.id, error: error instanceof Error ? error.message : error },
            "support mail not delivered",
          );
        }
      }
      return reply.code(201).send({ ok: true, id: ticket.id, createdAt: ticket.createdAt, notified, mailConfigured: Boolean(settings) });
    } catch (error) {
      // Отказ по картинке — это ошибка ввода, а не сбой сервера: человек должен увидеть, что не так.
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось отправить обращение" });
    }
  });

  /**
   * Список обращений: без картинок, только их размер. Свежие первыми. Отвечает и администратору
   * платформы, и внешней админке по ключу.
   */
  app.get("/api/support/tickets", async (request, reply) => {
    if (!(await allowTicketRead(request, reply))) return;
    applyNoStoreToReply(reply);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    const tickets = await listSupportTickets(query.limit ?? 50);
    // Обращения, созданные до появления снимка, дополняются при чтении. Один запрос на аккаунт,
    // даже если у него несколько тикетов; ошибка карточки не скрывает само обращение.
    const cache = new Map<string, Promise<SupportReporter | null>>();
    await Promise.all(tickets.filter(ticket => !ticket.reporter).map(async ticket => {
      let pending = cache.get(ticket.userId);
      if (!pending) {
        pending = supportReporterFor(ticket.userId).catch(error => {
          request.log.warn(
            { supportTicket: ticket.id, error: error instanceof Error ? error.message : error },
            "support reporter lookup failed",
          );
          return null;
        });
        cache.set(ticket.userId, pending);
      }
      const reporter = await pending;
      if (reporter) ticket.reporter = reporter;
    }));
    return { tickets };
  });

  /**
   * Карточка одного обращения для админки: сам тикет, живая карточка автора и его прошлые
   * обращения. Снимок в тикете отвечает «кем человек был тогда», `user` — «кем он является
   * сейчас»; расхождение между ними часто и есть ответ на вопрос поддержки.
   */
  app.get("/api/support/tickets/:id", async (request, reply) => {
    if (!(await allowTicketRead(request, reply))) return;
    applyNoStoreToReply(reply);
    const params = z.object({ id: z.string().min(8).max(64) }).parse(request.params);
    const ticket = await getSupportTicket(params.id);
    if (!ticket) return reply.code(404).send({ error: "Обращение не найдено" });

    let user = null;
    try {
      user = await loadSupportUser(ticket.userId);
      // У старых тикетов снимка нет: карточка на чтении уже собрана, не заставляем админку
      // делать второй запрос ради тех же полей.
      if (user && !ticket.reporter) ticket.reporter = supportReporterFrom(user);
    } catch (error) {
      request.log.warn(
        { supportTicket: ticket.id, error: error instanceof Error ? error.message : error },
        "support user card failed",
      );
    }
    return {
      ticket,
      user,
      history: await supportTicketsForUser(ticket.userId, 20),
    };
  });

  app.get("/api/support/tickets/:id/screenshot", async (request, reply) => {
    if (!(await allowTicketRead(request, reply))) return;
    const params = z.object({ id: z.string().min(8).max(64) }).parse(request.params);
    const screenshot = await readSupportScreenshot(params.id);
    if (!screenshot) return reply.code(404).send({ error: "Скриншот не найден" });
    return reply.type(screenshot.mime).header("Cache-Control", "private, no-store").send(screenshot.buffer);
  });
}
