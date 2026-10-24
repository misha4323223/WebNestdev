import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { requestAccess, type AccessKind } from "../access/pending-access.js";
import { resolveAccessTarget } from "../access/targets.js";
import { getCloudConnection } from "../cloud/connections.js";
import { getDomainConnection } from "../domains/connections.js";
import { getServiceConnection } from "../services/connections.js";
import { getYandexConnection } from "../yandex/yandex-connection-store.js";
import { databaseStatus } from "../database/database-api.js";

/**
 * Доступ к провайдеру — это не ключ приложения. Ключ приложения живёт в секретах проекта и
 * читается кодом как `process.env`; доступ к облаку, регистратору или сервису живёт в
 * зашифрованном хранилище интеграций и открывает агенту инструменты провайдера. Поэтому
 * просьба о доступе отдельная: карточка в чате показывает ровно те поля, которые требует
 * кабинет, сохраняет их и только после этого запуск продолжается.
 */

const kindSchema = z.enum(["cloud", "domain", "service", "database", "yandex"]);
const inputSchema = z.object({
  kind: kindSchema,
  provider: z.string().trim().min(1).max(80),
  purpose: z.string().trim().max(400).optional(),
  allowWrites: z.boolean().optional(),
});

const USAGE: Record<AccessKind, string> = {
  cloud: "cloud.status → cloud.request",
  domain: "domain.list → domain.request",
  service: "service.status → service.env",
  database: "database.status → database.env",
  yandex: "yandex.status → yandex.resources / yandex.request",
};

async function connectedAccount(kind: AccessKind, providerId: string, userId: string) {
  if (kind === "cloud") {
    const connection = await getCloudConnection(userId, providerId as never);
    return connection ? { account: connection.account, allowWrites: connection.allowWrites } : null;
  }
  if (kind === "domain") {
    const connection = await getDomainConnection(userId, providerId as never);
    return connection ? { account: connection.account, allowWrites: connection.allowWrites } : null;
  }
  if (kind === "service") {
    const connection = await getServiceConnection(userId, providerId);
    return connection ? { account: connection.account, allowWrites: null } : null;
  }
  if (kind === "yandex") {
    const connection = await getYandexConnection(userId);
    return connection ? { account: connection.account ?? "Yandex Cloud", allowWrites: connection.allowWrites } : null;
  }
  const status = await databaseStatus(userId);
  return status.connected ? { account: status.engine + " · " + status.host, allowWrites: null } : null;
}

registerTool({
  name: "access.request",
  description:
    "Ask the user for provider credentials you do not have, right in the chat: cloud (kind 'cloud', provider 'timeweb'|'cloudru'|'mws'|'regru'), Yandex Cloud (kind 'yandex'), domain registrar (kind 'domain', provider 'regru'|'beget'|'timeweb'), a service from service.status (kind 'service', provider = service id), or a database connection string (kind 'database', provider 'database'). " +
    "A card with the provider's exact fields, steps and a documentation link appears in the conversation; the run pauses until the user saves or cancels. " +
    "Input: {kind:'cloud'|'domain'|'service'|'database'|'yandex', provider:string, purpose?:one line explaining what the access is for, allowWrites?:boolean}. " +
    "Use it DURING deployment instead of asking for a token, password or connection string in chat text. " +
    "If the provider is already connected it returns alreadyConnected:true without showing anything — call it anyway before asking the user. " +
    "After ok:true, use the matching tools (cloud.request, domain.request, service.env, database.env, yandex.request) and never print the value. " +
    "Never write a credential into deploy_project.md: the plan names only the provider and the environment variable. " +
    "If the user cancels, do not repeat the request in chat: continue with what can be done or mark the step blocked with the exact cabinet action and docs link.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "provider"],
    properties: {
      kind: { type: "string", enum: ["cloud", "domain", "service", "database", "yandex"], description: "Что именно нужно подключить." },
      provider: { type: "string", description: "Id провайдера из каталога: timeweb, cloudru, mws, regru, beget, id сервиса или 'database'. Для Yandex Cloud укажите kind 'yandex'." },
      purpose: { type: "string", description: "Одна строка: зачем агенту этот доступ." },
      allowWrites: { type: "boolean", description: "Разрешить агенту создавать и менять ресурсы провайдера. По умолчанию true для облака/домена/Yandex; пользователь подтверждает в карточке." },
    },
  },
  execute: async (input, context) => {
    const parsed = inputSchema.parse(input ?? {});
    const kind = parsed.kind as AccessKind;
    const target = resolveAccessTarget(kind, parsed.provider);

    const existing = await connectedAccount(kind, target.providerId, context.userId);
    if (existing) {
      return {
        ok: true,
        alreadyConnected: true,
        kind,
        provider: target.providerId,
        name: target.name,
        account: existing.account,
        allowWrites: existing.allowWrites,
        note: target.name + " уже подключён. Используй " + USAGE[kind] + ". Значение ключа тебе недоступно и не нужно.",
      };
    }

    const purpose = parsed.purpose || "Доступ нужен агенту, чтобы выполнить развёртывание.";
    const { request, answer } = requestAccess({
      projectId: context.projectId,
      userId: context.userId,
      kind,
      providerId: target.providerId,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    // Карточка открывается этим событием и отвечает отдельным HTTP-запросом: значение не
    // проходит через поток запуска и не попадает ни в переписку, ни в контекст модели.
    context.emit?.({
      type: "access.requested",
      runId: context.runId,
      requestId: request.id,
      kind,
      provider: target.providerId,
      name: target.name,
      purpose,
      fields: target.fields,
      steps: target.steps,
      ...(target.keyUrl ? { keyUrl: target.keyUrl } : {}),
      ...(target.docsUrl ? { docsUrl: target.docsUrl } : {}),
      verificationNote: target.verificationNote,
      writes: target.writes,
      defaultAllowWrites: parsed.allowWrites ?? true,
      expiresAt: request.expiresAt,
    });

    const resolution = await answer;
    if (resolution.ok) {
      return {
        ok: true,
        kind,
        provider: target.providerId,
        name: target.name,
        account: resolution.account,
        note:
          "Доступ к " + target.name + " сохранён в зашифрованном хранилище интеграций. Значение тебе недоступно — не спрашивай его и не печатай. " +
          "Дальше используй " + USAGE[kind] + ". Если это облако или домен, проверь allowWrites перед изменением ресурсов.",
      };
    }
    if ("cancelled" in resolution) {
      return {
        ok: false,
        cancelled: true,
        kind,
        provider: target.providerId,
        note:
          "Пользователь отказался подключать " + target.name + ". Не повторяй просьбу в чате: продолжи с тем, что уже доступно, " +
          "а шаг, который без этого невозможен, отметь blocked в deploy.plan и назови точное действие в кабинете.",
      };
    }
    return {
      ok: false,
      kind,
      provider: target.providerId,
      error: resolution.error,
      note: "Доступ не сохранён. Не проси ключ текстом: объясни, что осталось заблокированным, и предложи повторить запрос позже.",
    };
  },
});
