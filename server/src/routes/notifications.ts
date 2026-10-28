import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  publicNotification,
} from "../account/notification-store.js";

/**
 * Уведомления аккаунта. Это пользовательские маршруты, а не админские: администратор пишет
 * уведомление действием над аккаунтом, а человек читает его здесь, уже под своей сессией.
 *
 * Список отдаёт и готовый текст, и значения (`tokens`, `plan`, `planUntil`), поэтому интерфейс
 * не разбирает сообщение обратно. `unread` считается по тому же списку, что показан: счётчик
 * на колокольчике не должен расходиться с тем, что человек видит в панели.
 */

const paramsSchema = z.object({ id: z.string().min(1).max(100) });
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export async function registerNotificationRoutes(app: FastifyInstance) {
  app.get("/api/me/notifications", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    applyNoStoreToReply(reply);

    const query = querySchema.safeParse(request.query ?? {});
    if (!query.success) {
      return reply.code(400).send({ error: "Некорректный запрос" });
    }
    const notifications = (await listNotifications(user.id, query.data.limit)).map(publicNotification);
    return {
      notifications,
      unread: notifications.filter(item => !item.readAt).length,
    };
  });

  app.post("/api/me/notifications/:id/read", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    applyNoStoreToReply(reply);

    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "Некорректный запрос" });

    const found = await markNotificationRead(user.id, params.data.id);
    if (!found) return reply.code(404).send({ error: "Уведомление не найдено" });
    return { ok: true };
  });

  /**
   * Отметить всё прочитанным одним запросом, а не N вызовами по каждому пункту: колокольчик
   * открывают, чтобы прочитать список, и счётчик должен исчезнуть сразу.
   */
  app.post("/api/me/notifications/read-all", async (request, reply) => {
    const user = await requireUser(request, reply); if (!user) return;
    applyNoStoreToReply(reply);
    const read = await markAllNotificationsRead(user.id);
    return { ok: true, read };
  });
}
