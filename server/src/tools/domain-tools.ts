import { z } from "zod";
import { registerTool } from "../tool-registry.js";
import { checkDomain } from "../domains/rdap.js";
import { listDomainConnections } from "../domains/connections.js";
import { listRegistrarDomains } from "../domains/registrar-api.js";
import { DOMAIN_REGISTRARS } from "../domains/providers.js";

/**
 * Домены без ключей: агент может проверить, свободно ли имя, через публичный RDAP —
 * это не требует аккаунта регистратора и не тратит деньги пользователя. Регистрация
 * и оплата остаются за человеком: у регистраторов нет OAuth для сторонних приложений,
 * а списывать деньги чужим ключом агент не должен.
 */

const MAX_NAMES = 8;

const inputSchema = z.object({
  names: z.union([z.string(), z.array(z.string())]).optional(),
  domain: z.string().optional(),
});

function namesFrom(input: z.infer<typeof inputSchema>) {
  const raw = input.names ?? input.domain;
  if (!raw) throw new Error("Укажите домены: {names:[\"example.ru\"]}");
  const list = (Array.isArray(raw) ? raw : [raw]).map(name => name.trim()).filter(Boolean);
  if (!list.length) throw new Error("Пустой список доменов");
  if (list.length > MAX_NAMES) throw new Error("За один вызов можно проверить не больше " + MAX_NAMES + " доменов");
  return [...new Set(list)];
}

registerTool({
  name: "domain.check",
  description:
    "Check whether domain names are free, using the public RDAP registry data — no account, key or payment needed. " +
    "Input: {names:string[]} (up to " + MAX_NAMES + ", a single string also works). Accepts punycode or Cyrillic names " +
    "(пример.рф) and full URLs. Returns for each name status 'available' | 'taken' | 'unknown' with a short detail; " +
    "'unknown' means the registry did not answer and tells nothing about the name. " +
    "Use it before recommending a domain to the user, when the user asks whether a name is taken, and after the user picks " +
    "a domain but before they pay for it. This tool only reads public data: it cannot register, renew, transfer or configure " +
    "DNS — that is done by the user in the registrar's panel, and never claim a domain was registered.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      names: {
        anyOf: [
          { type: "string", description: "Одно имя, например example.ru" },
          { type: "array", items: { type: "string" }, maxItems: MAX_NAMES, description: "Несколько имён" },
        ],
      },
    },
  },
  execute: async input => {
    const names = namesFrom(inputSchema.parse(input ?? {}));
    const results = await Promise.all(names.map(async name => {
      try {
        return await checkDomain(name);
      } catch (error) {
        return { domain: name, status: "unknown" as const, detail: error instanceof Error ? error.message : String(error) };
      }
    }));
    const available = results.filter(result => result.status === "available").map(result => result.domain);
    return {
      results,
      available,
      hint: available.length
        ? "Свободные имена: " + available.join(", ") + ". Регистрацию и оплату выполняет пользователь у своего регистратора — предложите ему это сделать."
        : "Свободных имён в ответе нет. Для статуса unknown попробуйте другой вариант имени: реестр не ответил.",
    };
  },
});

registerTool({
  name: "domain.list",
  description:
    "List the domains the user already owns, read from the registrar cabinets they connected in «Интеграции» → «Домены» " +
    "(REG.RU, Beget, Timeweb Cloud). Input: {registrar?} — one registrar id, or omit to read every connected one. " +
    "Call it when the user asks which domains they have, before proposing to buy a new one, and when checking whether a name is already theirs. " +
    "Read-only: it never registers, renews, transfers or changes DNS, and never returns the password or token.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      registrar: { type: "string", enum: ["regru", "beget", "timeweb"], description: "Один регистратор; без поля — все подключённые" },
    },
  },
  execute: async (input, context) => {
    const wanted = typeof (input as { registrar?: unknown } | null)?.registrar === "string"
      ? (input as { registrar: string }).registrar
      : null;
    const connections = (await listDomainConnections(context.userId))
      .filter(connection => !wanted || connection.provider === wanted);
    if (!connections.length) {
      const requested = wanted ? "Кабинет " + (DOMAIN_REGISTRARS.find(registrar => registrar.id === wanted)?.name ?? wanted) + " не подключён." : "Ни один кабинет регистратора не подключён (REG.RU, Beget, Timeweb Cloud).";
      return {
        registrars: [],
        hint: requested + " Попросите пользователя открыть «Интеграции» → «Домены» и подключить регистратора — затем повторите вызов.",
      };
    }
    const registrars: Array<{ provider: string; name: string; account: string; domains?: unknown; total?: number; error?: string }> = [];
    for (const connection of connections) {
      const registrar = DOMAIN_REGISTRARS.find(item => item.id === connection.provider);
      try {
        const result = await listRegistrarDomains(connection.provider, JSON.parse(connection.secret) as Record<string, string>);
        registrars.push({
          provider: connection.provider,
          name: registrar?.name ?? connection.provider,
          account: result.account,
          domains: result.domains.slice(0, 500),
          total: result.domains.length,
        });
      } catch (error) {
        registrars.push({
          provider: connection.provider,
          name: registrar?.name ?? connection.provider,
          account: connection.account,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const notConnected = DOMAIN_REGISTRARS.filter(item => !connections.some(connection => connection.provider === item.id)).map(item => item.name);
    return {
      registrars,
      notConnected,
      hint: "Список прочитан из кабинетов регистраторов. Регистрация и оплата — действия пользователя в кабинете; платформа домены не покупает и DNS не меняет.",
    };
  },
});
