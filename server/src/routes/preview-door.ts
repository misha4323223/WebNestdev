import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getProject } from "../project-store.js";
import { previewStatus } from "../preview-manager.js";
import { setPreviewExecOnly, unsettlePreview } from "../preview/preview-store.js";
import { previewDoorToken, previewDoorTokenValid } from "../preview/door-token.js";
import type { PreviewStatus } from "../preview/types.js";

/**
 * Внутренний канал «дверь ↔ API» (пункт 6.1 плана масштабирования).
 *
 * Дверь публичных адресов отдаёт байты приложения, но не хранит состояние предпросмотра: карта
 * живых предпросмотров (`preview/preview-store.ts`) принадлежит процессу API. Когда дверь работает
 * отдельным процессом, эти два маршрута — единственное, что ей нужно от API:
 *
 * - `lookup` — существует ли проект и что сейчас с его предпросмотром (адрес, порт, контейнер);
 * - `event` — уточнение, которое увидела дверь: адрес перестал отвечать или запросы пошли внутрь
 *   контейнера через `docker exec`.
 *
 * Оба закрыты общим токеном (preview/door-token.ts), а не сетью: Caddy проксирует `/api/*`
 * наружу, поэтому «внутренний адрес» сам по себе доступа не ограничивает. Публичного смысла у
 * маршрутов нет — они отдают устройство конкретного предпросмотра.
 *
 * Ответ на `lookup` не кешируется на стороне API: кеш живёт в двери (одна секунда), потому что
 * именно она читает статус на каждый файл приложения.
 */

export type PreviewDoorRouteDeps = {
  projectExists: (projectId: string) => Promise<boolean>;
  status: (projectId: string) => Promise<PreviewStatus>;
  unsettle: (projectId: string) => boolean;
  setExecOnly: (projectId: string, value: boolean) => boolean;
};

const defaultDeps: PreviewDoorRouteDeps = {
  projectExists: async projectId => (await getProject(projectId)) !== null,
  status: previewStatus,
  unsettle: unsettlePreview,
  setExecOnly: setPreviewExecOnly,
};

/** Идентификатор проекта в теле: непустая строка разумной длины, без разбора в PG. */
function projectIdFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { projectId?: unknown }).projectId;
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= 128 ? id : null;
}

function deny(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = previewDoorToken();
  if (!expected) {
    // Ключа шифрования нет — выводить токен не из чего. 503, а не 401: это не «дверь не та»,
    // а «API не настроен», и строка в логе выкатки должна читаться именно так.
    void reply.code(503).send({ ok: false, error: "WEBNESTDEV_ENCRYPTION_KEY не задан — внутренний канал двери закрыт" });
    return false;
  }
  if (!previewDoorTokenValid(request.headers.authorization, expected)) {
    void reply.code(401).send({ ok: false, error: "Внутренний маршрут двери предпросмотра: нужен токен двери" });
    return false;
  }
  return true;
}

export async function registerPreviewDoorRoutes(app: FastifyInstance, deps: PreviewDoorRouteDeps = defaultDeps) {
  app.post("/api/internal/preview/lookup", async (request, reply) => {
    if (!deny(request, reply)) return reply;
    const projectId = projectIdFrom(request.body);
    if (!projectId) return reply.code(400).send({ ok: false, error: "Нужен projectId" });
    // Существование проекта проверяется до статуса: у удалённого проекта предпросмотра быть не
    // может, а `previewStatus` для него всё равно вернул бы `running: false`.
    const exists = await deps.projectExists(projectId);
    const status = exists ? await deps.status(projectId) : { running: false as const };
    return { ok: true, exists, status };
  });

  app.post("/api/internal/preview/event", async (request, reply) => {
    if (!deny(request, reply)) return reply;
    const projectId = projectIdFrom(request.body);
    if (!projectId) return reply.code(400).send({ ok: false, error: "Нужен projectId" });
    const body = request.body as { event?: unknown; value?: unknown };
    if (body.event === "unsettle") {
      return { ok: true, changed: deps.unsettle(projectId) };
    }
    if (body.event === "exec-only") {
      if (typeof body.value !== "boolean") return reply.code(400).send({ ok: false, error: "Для exec-only нужен value: boolean" });
      return { ok: true, changed: deps.setExecOnly(projectId, body.value) };
    }
    return reply.code(400).send({ ok: false, error: "Неизвестное событие двери: ожидается unsettle или exec-only" });
  });
}
