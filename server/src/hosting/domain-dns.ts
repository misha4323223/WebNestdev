import dns from "node:dns/promises";
import { customDomainDnsServers } from "./domain-config.js";
import { customDomainTxtValue } from "./domain-name.js";

/**
 * DNS-проверки с явным интерфейсом резолвера.
 *
 * В production используется системный DNS (или серверы из `CUSTOM_DOMAIN_DNS_SERVERS`),
 * в тестах — подменный резолвер. Это позволяет проверить TXT/A/CNAME/CAA без сети и не
 * превращать тест в зависимость от чужой зоны.
 */

export type DnsResolver = {
  resolveTxt(name: string): Promise<string[][]>;
  resolve4(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  resolveCaa(name: string): Promise<Array<{ critical: number; issue?: string; issuewild?: string; iodef?: string }>>;
};

export type DnsCheck = { allowed: boolean; reason: string };

const DNS_TIMEOUT_MS = 5_000;
const DNS_ERRORS = new Set(["ENOTFOUND", "ENODATA", "ESERVFAIL", "ETIMEOUT", "EAI_AGAIN", "ECONNREFUSED"]);

function errorCode(error: unknown): string {
  return String((error as { code?: string } | null)?.code ?? "");
}

function reasonForError(error: unknown, missing: string): string {
  const code = errorCode(error);
  if (DNS_ERRORS.has(code)) return missing;
  return "DNS временно недоступен, повторим проверку позже";
}

async function withTimeout<T>(action: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("DNS timeout") as Error & { code: string };
          error.code = "ETIMEOUT";
          reject(error);
        }, DNS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createSystemDnsResolver(): DnsResolver {
  const resolver = new dns.Resolver();
  const servers = customDomainDnsServers();
  if (servers.length) resolver.setServers(servers);
  return {
    resolveTxt: name => withTimeout(resolver.resolveTxt(name)),
    resolve4: name => withTimeout(resolver.resolve4(name)),
    resolveCname: name => withTimeout(resolver.resolveCname(name)),
    resolveCaa: name => withTimeout(resolver.resolveCaa(name)),
  };
}

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** TXT может быть разбит DNS-сервером на несколько строк; склеиваем до сравнения. */
export async function checkTxt(
  verificationHost: string,
  token: string,
  resolver: DnsResolver,
): Promise<DnsCheck> {
  try {
    const records = await resolver.resolveTxt(verificationHost);
    const expected = customDomainTxtValue(token);
    const found = records.some(chunks => chunks.join("") === expected);
    return found
      ? { allowed: true, reason: "TXT-запись найдена" }
      : { allowed: false, reason: "TXT-запись не совпадает с токеном" };
  } catch (error) {
    return { allowed: false, reason: reasonForError(error, "TXT-запись не найдена") };
  }
}

/**
 * Трафик считается направленным на нас, если hostname — CNAME на наш target или A
 * содержит адрес NLB. Apex может использовать CNAME flattening, поэтому A проверяется для
 * любого типа, а не только для apex.
 */
export async function checkTraffic(
  hostname: string,
  target: string,
  ip: string,
  resolver: DnsResolver,
): Promise<DnsCheck> {
  const wantedTarget = normalizeTarget(target);
  try {
    const cnames = await resolver.resolveCname(hostname);
    if (cnames.some(name => normalizeTarget(name) === wantedTarget)) {
      return { allowed: true, reason: "CNAME указывает на наш хостинг" };
    }
    if (cnames.length) {
      return { allowed: false, reason: "CNAME указывает на другой хостинг" };
    }
  } catch (error) {
    if (!DNS_ERRORS.has(errorCode(error))) {
      return { allowed: false, reason: reasonForError(error, "CNAME не найден") };
    }
  }

  try {
    const addresses = await resolver.resolve4(hostname);
    if (addresses.includes(ip)) return { allowed: true, reason: "A-запись указывает на наш хостинг" };
  } catch (error) {
    if (!DNS_ERRORS.has(errorCode(error))) {
      return { allowed: false, reason: reasonForError(error, "A-запись не найдена") };
    }
  }

  return { allowed: false, reason: "Домен пока не указывает на наш хостинг" };
}

function issueAllowsLetsEncrypt(records: Array<{ issue?: string; issuewild?: string }>): boolean {
  // Для обычного сертификата (не wildcard) действует только `issue`, а не `issuewild`.
  // Если `issue` нет, политика CA не ограничена: CAA с одним iodef или только issuewild
  // не должен мешать выпуску сертификата на apex/www.
  const issues = records
    .map(record => record.issue)
    .filter((value): value is string => value !== undefined);
  if (!issues.length) return true;
  return issues.some(value => value.split(";")[0].trim().toLowerCase() === "letsencrypt.org");
}

/**
 * Проверяем CAA на самом имени и на всех родительских зонах до registrable root. Политика
 * наследуется вниз, поэтому одной записи на `www` недостаточно: запрет часто стоит на apex
 * или на промежуточной зоне.
 */
export async function checkCaa(
  hostname: string,
  resolver: DnsResolver,
  rootDomain?: string,
): Promise<DnsCheck> {
  const names: string[] = [];
  const labels = hostname.split(".");
  for (let index = 0; index < labels.length - 1; index++) {
    const name = labels.slice(index).join(".");
    // CAA-политика наследуется вниз по дереву: проверяем все промежуточные зоны между
    // hostname и registrable root, иначе запрет на `shop.example.ru` можно обойти через
    // `a.shop.example.ru`.
    names.push(name);
    if (rootDomain && name === rootDomain) break;
    if (!rootDomain && name.split(".").length === 2) break;
  }
  for (const name of names) {
    try {
      const records = await resolver.resolveCaa(name);
      if (!records.length) continue;
      if (!issueAllowsLetsEncrypt(records)) {
        return {
          allowed: false,
          reason: "CAA запрещает Let’s Encrypt. Разрешите letsencrypt.org в DNS.",
        };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENODATA" || code === "ENOTFOUND") continue;
      return { allowed: false, reason: reasonForError(error, "CAA не удалось проверить") };
    }
  }
  return { allowed: true, reason: "CAA не запрещает выпуск" };
}
