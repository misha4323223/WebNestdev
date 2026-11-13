import { getDomain as getRegistrableDomain } from "tldts";
import { accountPlanFor } from "../billing/store.js";
import { customDomainLimitFor } from "../account/plans.js";
import { customDomainIp, customDomainTarget, customDomainsEnabled } from "./domain-config.js";
import { checkCaa, checkTraffic, checkTxt, createSystemDnsResolver, type DnsResolver } from "./domain-dns.js";
import { normalizeCustomDomainGroup } from "./domain-name.js";
import {
  countDomainGroups,
  createDomainGroup,
  deleteDomainGroup,
  getDomain as getDomainById,
  getDomainByHostname,
  listDomainsByGroup,
  listDomainsBySite,
  setCanonical,
  updateDomain,
} from "./domain-store.js";
import type { CustomDomain, CustomDomainCheck, CustomDomainDnsRecord, CustomDomainVerificationResult } from "./domain-types.js";
import { hostingPublicDomain } from "./config.js";
import type { HostingSite } from "./types.js";
import { HostingError } from "./types.js";

/**
 * Бизнес-слой доменов: тариф, создание, DNS-инструкции и проверка владения.
 * Маршруты не должны самостоятельно решать, можно ли пользователю подключить домен.
 */

export type CreateCustomDomainRequest = {
  hostname: string;
  includeWww?: boolean;
};

function assertEnabled() {
  if (!customDomainsEnabled()) {
    throw new HostingError("CUSTOM_DOMAINS_DISABLED", "Подключение своих доменов временно выключено", 503);
  }
}

function assertSiteUsable(site: HostingSite) {
  if (site.status === "deleted") throw new HostingError("SITE_NOT_FOUND", "Сайт не найден", 404);
  if (site.status === "suspended") throw new HostingError("SITE_SUSPENDED", "Сайт приостановлен", 409);
}

export async function assertCustomDomainAccess(userId: string): Promise<number> {
  assertEnabled();
  const plan = await accountPlanFor(userId);
  const limit = customDomainLimitFor(plan);
  if (limit <= 0) {
    throw new HostingError(
      "DOMAIN_PLAN_REQUIRED",
      "Свой домен доступен на тарифах «Плюс» и «Премиум»",
      403,
    );
  }
  return limit;
}

function reservedDomains(): string[] {
  const domains = ["nestdev.ru", "host.nestdev.ru", "preview.nestdev.ru", "custom.nestdev.ru"];
  const configured = process.env.WEBNESTDEV_SITE_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
  if (configured) domains.push(configured);
  try {
    domains.push(hostingPublicDomain());
  } catch {
    // Некорректная конфигурация хостинга не должна мешать проверке собственных имён.
  }
  try {
    // Сам CNAME-target тоже принадлежит платформе: клиент не должен занять его своим сайтом.
    domains.push(customDomainTarget());
  } catch {
    // Ошибка конфигурации target проявится при выдаче DNS-инструкций.
  }
  return [...new Set(domains)];
}

export async function createCustomDomains(
  site: HostingSite,
  userId: string,
  input: CreateCustomDomainRequest,
): Promise<CustomDomain[]> {
  assertSiteUsable(site);
  const limit = await assertCustomDomainAccess(userId);
  const group = normalizeCustomDomainGroup(input.hostname, {
    includeWww: input.includeWww !== false,
    reservedDomains: reservedDomains(),
  });
  await expirePendingGroups(site.id);
  for (const item of group.hostnames) {
    const existing = await getDomainByHostname(item.hostname);
    if (existing) {
      // Просроченная заявка могла остаться у другого сайта: освобождаем её и проверяем снова.
      await expirePendingGroups(existing.siteId);
      if (await getDomainByHostname(item.hostname)) {
        throw new HostingError("DOMAIN_TAKEN", "Этот домен уже подключён", 409);
      }
    }
  }
  if (await countDomainGroups(site.id) >= limit) {
    throw new HostingError("DOMAIN_LIMIT", "На этом тарифе можно подключить один свой домен к сайту", 409);
  }
  return createDomainGroup({
    siteId: site.id,
    userId,
    hostnames: group.hostnames,
    maxGroups: limit,
  });
}

export function dnsRecordsForDomain(
  domain: CustomDomain,
  options: { target?: string; ip?: string } = {},
): CustomDomainDnsRecord[] {
  const target = options.target ?? customDomainTarget();
  const ip = options.ip ?? customDomainIp();
  const verification: CustomDomainDnsRecord = {
    type: "TXT",
    name: domain.verificationHost,
    relativeName: domain.verificationHost,
    value: "nestdev-verify=" + domain.verificationToken,
    purpose: "verification",
  };
  const traffic: CustomDomainDnsRecord = domain.kind === "apex"
    ? {
        type: "A",
        name: domain.hostname,
        relativeName: "@",
        value: ip,
        purpose: "traffic",
      }
    : {
        type: "CNAME",
        name: domain.hostname,
        relativeName: domain.kind === "www" ? "www" : domain.hostname,
        value: target + ".",
        purpose: "traffic",
      };
  return [verification, traffic];
}

export function publicCustomDomain(domain: CustomDomain) {
  return {
    id: domain.id,
    groupId: domain.groupId,
    hostname: domain.hostname,
    displayHostname: domain.displayHostname,
    kind: domain.kind,
    status: domain.status,
    isCanonical: domain.isCanonical,
    verifiedAt: domain.verifiedAt,
    lastCheckedAt: domain.lastCheckedAt,
    lastError: domain.lastError,
    certificateStatus: domain.certificateStatus,
    certificateError: domain.certificateError,
    dns: dnsRecordsForDomain(domain),
  };
}

async function expirePendingGroups(siteId: string): Promise<void> {
  const domains = await listDomainsBySite(siteId);
  const groups = new Map<string, CustomDomain[]>();
  for (const domain of domains) {
    groups.set(domain.groupId, [...(groups.get(domain.groupId) ?? []), domain]);
  }
  const now = Date.now();
  for (const group of groups.values()) {
    const expired = group.every(domain => domain.status === "pending_dns")
      && group.some(domain => domain.expiresAt !== null && Date.parse(domain.expiresAt) < now);
    if (expired) await deleteDomainGroup(siteId, group[0].id);
  }
}

export async function domainsForSite(siteId: string): Promise<CustomDomain[]> {
  await expirePendingGroups(siteId);
  return listDomainsBySite(siteId);
}

export async function verifyDomainGroup(
  siteId: string,
  domainId: string,
  resolver: DnsResolver = createSystemDnsResolver(),
): Promise<CustomDomainVerificationResult> {
  assertEnabled();
  const domain = await getDomainById(domainId);
  if (!domain || domain.siteId !== siteId) {
    throw new HostingError("DOMAIN_NOT_FOUND", "Домен не найден", 404);
  }
  const group = await listDomainsByGroup(domain.groupId);
  const target = customDomainTarget();
  const ip = customDomainIp();
  const now = new Date().toISOString();
  const checks: CustomDomainCheck[] = [];
  const updated: CustomDomain[] = [];

  for (const item of group) {
    // TXT, трафик и CAA независимы; последовательные запросы складывали бы таймауты DNS
    // в один HTTP-запрос, и панель ждала бы десятки секунд.
    const [txt, traffic, caa] = await Promise.all([
      checkTxt(item.verificationHost, item.verificationToken, resolver),
      checkTraffic(item.hostname, target, ip, resolver),
      checkCaa(item.hostname, resolver, getRegistrableDomain(item.hostname) ?? undefined),
    ]);
    const error = !txt.allowed ? txt.reason : !traffic.allowed ? traffic.reason : !caa.allowed ? caa.reason : "";
    // `verified` — только владение. `configuring` — владение + трафик + CAA: именно это
    // состояние Caddy может спросить у `/api/tls-ask` перед первым выпуском сертификата.
    const nextStatus = item.status === "active"
      ? "active"
      : txt.allowed && traffic.allowed && caa.allowed
        ? "configuring"
        : txt.allowed
          ? "verified"
          : "pending_dns";
    const next = await updateDomain(item.id, {
      status: nextStatus,
      verifiedAt: txt.allowed ? item.verifiedAt ?? now : null,
      lastCheckedAt: now,
      lastError: error,
    });
    if (next) updated.push(next);
    checks.push({ hostname: item.hostname, txt, traffic, caa });
  }

  return { domains: updated, checks };
}

export async function setCanonicalForSite(siteId: string, domainId: string): Promise<CustomDomain[]> {
  const domain = await getDomainById(domainId);
  if (!domain || domain.siteId !== siteId) throw new HostingError("DOMAIN_NOT_FOUND", "Домен не найден", 404);
  return setCanonical(siteId, domainId);
}

export async function removeDomainGroup(siteId: string, domainId: string): Promise<boolean> {
  return deleteDomainGroup(siteId, domainId);
}

/**
 * Для `/api/tls-ask`: разрешаем только домены, у которых подтверждены владение, трафик и CAA.
 * `verified` здесь недостаточно: это только TXT, а трафик мог ещё не переключиться. `active`,
 * `configuring` и `issuing_certificate` уже прошли проверки; повторный ask нужен для продления.
 */
export async function customDomainForTls(hostname: string): Promise<CustomDomain | null> {
  const domain = await getDomainByHostname(hostname);
  return domain && (domain.status === "active" || domain.status === "configuring" || domain.status === "issuing_certificate")
    ? domain
    : null;
}
