/**
 * Проверка домена без единого аккаунта: агенту нужно отвечать «свободен ли», «предложи
 * три варианта» — и это не должно требовать ключа регистратора или согласия на покупку.
 *
 * Два источника:
 * - зоны .ru/.su/.рф — WHOIS службы TCI (у них нет RDAP);
 * - остальные зоны — публичный RDAP через бутстрап rdap.org.
 *
 * RDAP-бутстрап отвечает 404 и для свободного имени, и для зоны, которую он не обслуживает
 * (например .ru или .de). Различать обязательно: иначе занятый домен выглядел бы свободным.
 * Поэтому 404 с телом «No RDAP service is available» — это "unknown", а пустой 404 — "available".
 */

import { TCI_WHOIS_HOST, classifyWhois, whoisQuery } from "./whois.js";

export type DomainStatus = "available" | "taken" | "unknown";

export type DomainCheck = {
  domain: string;
  status: DomainStatus;
  detail?: string;
  source?: "whois" | "rdap";
};

/** Зоны службы TCI после приведения к ASCII (рф → xn--p1ai). */
const WHOIS_TLDS = new Set(["ru", "su", "xn--p1ai"]);
const MAX_DOMAIN_CHARS = 253;
const TIMEOUT_MS = 8000;
/** rdap.org отвечает 403 на User-Agent по умолчанию у node fetch, поэтому представляемся сами. */
const USER_AGENT = "webnestdev-domain-check/1.0";

export type DomainCheckDeps = {
  fetch?: typeof fetch;
  whois?: (domain: string, timeoutMs: number) => Promise<string>;
};

/** Кириллицу RDAP и WHOIS ждут в punycode, поэтому имя приводится к ASCII-форме. */
export function normalizeDomain(input: string) {
  const raw = input.trim().toLowerCase();
  if (!raw) throw new Error("Пустое имя домена");
  const withoutScheme = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = withoutScheme.split(/[/?#]/)[0].replace(/\.$/, "");
  if (host.length > MAX_DOMAIN_CHARS) throw new Error("Слишком длинное имя домена");
  if (!host.includes(".")) throw new Error("Нужен домен с зоной, например example.ru");
  let ascii: string;
  try {
    ascii = new URL("http://" + host).hostname;
  } catch {
    throw new Error("Некорректное имя домена: " + host);
  }
  if (!/^[a-z0-9.-]+$/.test(ascii) || ascii.includes("..") || ascii.startsWith("-") || ascii.endsWith("-")) {
    throw new Error("Некорректное имя домена: " + host);
  }
  return ascii;
}

export function domainTld(domain: string) {
  return domain.split(".").pop() ?? "";
}

export function usesWhois(domain: string) {
  return WHOIS_TLDS.has(domainTld(domain));
}

export function rdapUrl(domain: string) {
  return "https://rdap.org/domain/" + encodeURIComponent(domain);
}

/** 404 — свободен; 2xx — занят; всё остальное (429, 5xx, таймаут) — «не знаю». */
export function classifyRdapStatus(status: number): DomainStatus {
  if (status === 404) return "available";
  if (status >= 200 && status < 300) return "taken";
  return "unknown";
}

/** 404 бутстрапа для неподдерживаемой зоны — не «свободен», а «нет данных». */
export function classifyRdapResponse(status: number, body: string): DomainStatus {
  if (status === 404 && /No RDAP service is available/i.test(body)) return "unknown";
  return classifyRdapStatus(status);
}

async function checkViaRdap(domain: string, request: typeof fetch): Promise<DomainCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await request(rdapUrl(domain), {
      headers: { Accept: "application/rdap+json, application/json", "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text().catch(() => "");
    const status = classifyRdapResponse(response.status, body);
    return {
      domain,
      status,
      source: "rdap",
      ...(status === "unknown"
        ? { detail: response.status === 404 || response.ok ? "У зоны нет публичного RDAP" : "RDAP ответил HTTP " + response.status }
        : {}),
    };
  } catch (error) {
    return {
      domain,
      status: "unknown",
      source: "rdap",
      detail: "Нет ответа RDAP: " + (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkViaWhois(
  domain: string,
  query: (domain: string, timeoutMs: number) => Promise<string>,
): Promise<DomainCheck> {
  try {
    const answer = await query(domain, TIMEOUT_MS);
    const status = classifyWhois(answer);
    return {
      domain,
      status,
      source: "whois",
      ...(status === "unknown" ? { detail: "WHOIS " + TCI_WHOIS_HOST + " не дал однозначного ответа" } : {}),
    };
  } catch (error) {
    return {
      domain,
      status: "unknown",
      source: "whois",
      detail: "Нет ответа WHOIS: " + (error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function checkDomain(input: string, deps: DomainCheckDeps = {}): Promise<DomainCheck> {
  const domain = normalizeDomain(input);
  if (usesWhois(domain)) {
    return checkViaWhois(domain, deps.whois ?? ((name, timeoutMs) => whoisQuery(TCI_WHOIS_HOST, name, timeoutMs)));
  }
  return checkViaRdap(domain, deps.fetch ?? fetch);
}
