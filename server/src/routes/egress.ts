import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EGRESS_WHOIS_PURPOSE } from "../egress/config.js";
import { listPreviewsAcrossReplicas } from "../preview/preview-store.js";
import { bearerTokenValid, internalToken } from "../preview/door-token.js";

/**
 * Внутренний канал egress-прокси ↔ API (пункт 5.1 плана масштабирования).
 *
 * Прокси видит адрес источника и домен, на который шёл запрос, но не знает, чей это контейнер:
 * карта живых предпросмотров принадлежит процессу API. Один вопрос — `POST
 * /api/internal/egress/whois` — превращает «172.31.0.7 стучался на пример.рф» в «проект p-42
 * стучался на пример.рф», и журнал отказов становится пригодным для разбора.
 *
 * Маршрут закрыт токеном, выведенным из ключа шифрования с отдельным назначением (см.
 * preview/door-token.ts): `/api/*` виден через Caddy, поэтому «внутренний адрес» доступа не
 * ограничивает. Проект отдаётся только по адресу живого предпросмотра — перечислять проекты
 * маршрут не умеет.
 */

export type EgressRouteDeps = {
  projectByAddress: (address: string) => Promise<string | null>;
};

/**
 * Адрес → проект по карте предпросмотров. Контейнеры команд (npm install, агент) в карту не
 * попадают: для них журнал останется с адресом, и это честнее, чем приписать отказ чужому проекту.
 */
const defaultDeps: EgressRouteDeps = {
  projectByAddress: async address => (await listPreviewsAcrossReplicas()).find(state => state.host === address)?.projectId ?? null,
};

function addressFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as { address?: unknown }).address;
  if (typeof value !== "string") return null;
  const address = value.trim();
  // IPv4/IPv6 в текстовом виде; ничего другого прокси прислать не может.
  return address && address.length <= 64 && /^[0-9a-fA-F:.]{3,64}$/.test(address) ? address : null;
}

function deny(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = internalToken(EGRESS_WHOIS_PURPOSE);
  if (!expected) {
    void reply.code(503).send({ ok: false, error: "WEBNESTDEV_ENCRYPTION_KEY не задан — внутренний канал egress закрыт" });
    return false;
  }
  if (!bearerTokenValid(request.headers.authorization, expected)) {
    void reply.code(401).send({ ok: false, error: "Внутренний маршрут egress: нужен токен" });
    return false;
  }
  return true;
}

export async function registerEgressRoutes(app: FastifyInstance, deps: EgressRouteDeps = defaultDeps) {
  app.post("/api/internal/egress/whois", async (request, reply) => {
    if (!deny(request, reply)) return reply;
    const address = addressFrom(request.body);
    if (!address) return reply.code(400).send({ ok: false, error: "Нужен address" });
    const projectId = await deps.projectByAddress(address);
    return { ok: true, projectId };
  });
}
