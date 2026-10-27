import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { isPlatformAdmin, platformAdminGuide, platformAdminsConfigured } from "../platform/admin.js";
import { describeUnappliedName, parseEnvFileContent, platformEnvStatus, savePlatformEnv, type PlatformEnvStatus } from "../platform/platform-env.js";
import { isSameOriginRequest, sameOriginRefusal } from "../security/same-origin.js";
import { recordAudit } from "../security/audit-journal.js";
import { applyNoStoreToReply } from "./cache-headers.js";

export type PlatformRouteDeps = {
  authorize: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string; email: string } | null>;
  isAdmin: (user: { id: string; email: string }) => boolean;
  adminsConfigured: () => boolean;
  status: () => PlatformEnvStatus[];
  save: typeof savePlatformEnv;
  parseEnv: typeof parseEnvFileContent;
  describeUnapplied: (name: string) => string;
  guide: () => string;
  /** Журнал безопасности: имена изменённых ключей, но никогда их значения. */
  audit: typeof recordAudit;
};

const defaultDeps: PlatformRouteDeps = {
  authorize: (request, reply) => requireUser(request, reply),
  isAdmin: isPlatformAdmin,
  adminsConfigured: platformAdminsConfigured,
  status: platformEnvStatus,
  save: savePlatformEnv,
  parseEnv: parseEnvFileContent,
  describeUnapplied: describeUnappliedName,
  guide: platformAdminGuide,
  audit: recordAudit,
};

const saveSchema = z.object({
  /** Поля панели: имя ключа → значение; пустая строка возвращает ключ к переменной окружения. */
  values: z.record(z.string().max(120), z.string().max(100_000)).optional(),
  /** Содержимое загруженного .env: разбирается на сервере тем же парсером, что и поля. */
  env: z.string().max(200_000).optional(),
}).refine(body => Boolean(body.env?.trim() || Object.keys(body.values ?? {}).length), { message: "Пустой запрос: нет ни полей, ни файла .env" });

/**
 * Платформенные ключи (GitHub OAuth, Yandex Cloud, SMS, модель платформы) — это доступ к самому
 * сервису, а не к проекту, поэтому маршрут закрыт администратором, а сам список администраторов
 * читается только из окружения (platform/admin.ts). Значения шифруются и никогда не возвращаются
 * в браузер: статус показывает форму («sk-…f3a2», «строк: 23»), а не сам ключ.
 */
function guardPlatformRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  applyNoStoreToReply(reply);
  if (!isSameOriginRequest(request)) {
    void reply.code(403).send({ error: sameOriginRefusal() });
    return false;
  }
  return true;
}
export async function registerPlatformRoutes(app: FastifyInstance, overrides: Partial<PlatformRouteDeps> = {}) {
  const deps: PlatformRouteDeps = { ...defaultDeps, ...overrides };

  app.get("/api/platform/keys", async (request, reply) => {
    if (!guardPlatformRequest(request, reply)) return;
    const user = await deps.authorize(request, reply); if (!user) return;
    if (!deps.isAdmin(user)) {
      return { admin: false, adminsConfigured: deps.adminsConfigured(), guide: deps.guide() };
    }
    return { admin: true, adminsConfigured: true, keys: deps.status() };
  });

  app.post("/api/platform/keys", async (request, reply) => {
    if (!guardPlatformRequest(request, reply)) return;
    const user = await deps.authorize(request, reply); if (!user) return;
    if (!deps.isAdmin(user)) return reply.code(403).send({ error: "Ключи платформы может менять только администратор", guide: deps.guide() });
    const parsed = saveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректный запрос" });
    const body = parsed.data;

    const values: Record<string, string> = {};
    const skipped: Array<{ name: string; message: string }> = [];
    const known = new Set(deps.status().map(entry => entry.name));
    for (const line of deps.parseEnv(body.env ?? "")) {
      const name = line.name.trim().toUpperCase();
      if (!known.has(name)) {
        skipped.push({ name, message: deps.describeUnapplied(name) });
        continue;
      }
      // Пустой ключ в файле — это шаблон, а не указание стереть: в .env.example и у многих
      // провайдеров строки выглядят как `GITHUB_CLIENT_SECRET=`. Стереть значение можно только
      // явно — пустым полем панели.
      if (!line.value.trim()) continue;
      values[name] = line.value;
    }
    // Поля панели применяются последними: это осознанная правка конкретного ключа, и она должна
    // побеждать значение из загруженного файла.
    for (const [name, value] of Object.entries(body.values ?? {})) values[name.toUpperCase()] = value;

    const result = await deps.save(values);
    const allSkipped = [...skipped, ...result.skipped];
    if (!result.saved.length && !result.cleared.length && allSkipped.length) {
      return reply.code(400).send({ error: allSkipped.map(item => item.name + " — " + item.message).join("; "), skipped: allSkipped, status: deps.status() });
    }
    await deps.audit({
      action: "platform.keys.updated",
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email,
      ip: request.ip,
      details: {
        saved: result.saved.join(", "),
        cleared: result.cleared.join(", "),
        skipped: allSkipped.map(item => item.name).join(", "),
      },
    });
    return { saved: result.saved, cleared: result.cleared, skipped: allSkipped, status: deps.status() };
  });
}
