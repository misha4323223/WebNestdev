import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { savePlatformEnv } from "../platform/platform-env.js";
import { webSearchStatus } from "../web/search-settings.js";
import { YANDEX_SEARCH_FOLDER_ENV, YANDEX_SEARCH_KEY_ENV } from "../web/yandex-search.js";
import { TAVILY_KEY_ENV } from "../web/tavily.js";

const provider = z.string().trim().max(20)
  .refine(value => !value || /^(auto|duckduckgo|yandex|tavily)$/i.test(value), "Допустимо: auto, duckduckgo, yandex или tavily")
  .transform(value => value.toLowerCase());

/**
 * Настройка веб-поиска для внешней админки. Поля ключей необязательные: пустой `yandexApiKey`
 * или `tavilyApiKey` означает «оставить сохранённый», а удаление делается явным флагом.
 */
const searchSchema = z.object({
  provider: provider.optional(),
  yandexApiKey: z.string().trim().max(20_000).optional(),
  yandexFolderId: z.string().trim().max(200).optional(),
  tavilyApiKey: z.string().trim().max(20_000).optional(),
  clearYandexKey: z.boolean().optional(),
  clearTavilyKey: z.boolean().optional(),
  clearYandexFolderId: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.clearYandexKey && data.yandexApiKey?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Нельзя одновременно передать ключ Yandex и очистить его",
      path: ["yandexApiKey"],
    });
  }
  if (data.clearTavilyKey && data.tavilyApiKey?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Нельзя одновременно передать ключ Tavily и очистить его",
      path: ["tavilyApiKey"],
    });
  }
  if (data.clearYandexFolderId && data.yandexFolderId?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Нельзя одновременно передать каталог Yandex и очистить его",
      path: ["yandexFolderId"],
    });
  }
});

export async function registerAdminSearchRoutes(app: FastifyInstance) {
  app.get("/api/admin/search", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return { search: webSearchStatus() };
  });

  app.post("/api/admin/search", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const parsed = searchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Проверьте провайдера и ключи поиска" });
    }

    const values: Record<string, string> = {};
    if (parsed.data.provider !== undefined) values.WEB_SEARCH_PROVIDER = parsed.data.provider;
    if (parsed.data.yandexApiKey?.trim()) values[YANDEX_SEARCH_KEY_ENV] = parsed.data.yandexApiKey;
    if (parsed.data.yandexFolderId !== undefined) values[YANDEX_SEARCH_FOLDER_ENV] = parsed.data.yandexFolderId;
    if (parsed.data.tavilyApiKey?.trim()) values[TAVILY_KEY_ENV] = parsed.data.tavilyApiKey;
    if (parsed.data.clearYandexKey) values[YANDEX_SEARCH_KEY_ENV] = "";
    if (parsed.data.clearYandexFolderId) values[YANDEX_SEARCH_FOLDER_ENV] = "";
    if (parsed.data.clearTavilyKey) values[TAVILY_KEY_ENV] = "";
    if (!Object.keys(values).length) {
      return reply.code(400).send({ error: "Нечего сохранять: передайте провайдера, ключ или каталог" });
    }

    const result = await savePlatformEnv(values);
    if (result.skipped.length) {
      return reply.code(400).send({ error: result.skipped.map(item => item.name + " — " + item.message).join("; ") });
    }

    await recordAudit({
      action: "platform.search.updated",
      actorType: "admin",
      actorId: auth.admin.id,
      actorLabel: auth.admin.email,
      ip: request.ip,
      details: {
        saved: result.saved.join(", "),
        cleared: result.cleared.join(", "),
        provider: parsed.data.provider ?? null,
      },
    });

    return { saved: true, search: webSearchStatus() };
  });
}
