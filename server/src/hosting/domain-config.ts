import { isIP } from "node:net";
import { domainToASCII } from "node:url";

/**
 * Конфигурация пользовательских доменов отделена от общих лимитов хостинга: её можно
 * включить feature-flag'ом, не меняя поведение уже опубликованных `<slug>.host...` сайтов.
 *
 * `CUSTOM_DOMAIN_TARGET` — стабильное CNAME-имя, на которое клиенты направляют `www`.
 * `CUSTOM_DOMAIN_IP` — публичный адрес NLB для apex A-записи. Оба значения не являются
 * секретами, но проверяются при чтении, чтобы опечатка не попала в DNS-инструкции.
 */

function boolEnv(name: string): boolean {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function dnsName(name: string, value: string): string {
  const raw = (value ?? "").trim().toLowerCase().replace(/\.$/, "");
  const ascii = domainToASCII(raw);
  if (isIP(ascii) || !ascii || ascii.length > 253 || ascii.includes("..") || ascii.startsWith(".") || ascii.endsWith(".")) {
    throw new Error(name + " должен быть DNS-именем без схемы, порта и пути");
  }
  const labels = ascii.split(".");
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error(name + " содержит некорректную DNS-метку");
  }
  return ascii;
}

export function customDomainTarget(value = process.env.CUSTOM_DOMAIN_TARGET ?? "custom.nestdev.ru"): string {
  return dnsName("CUSTOM_DOMAIN_TARGET", value);
}

export function customDomainIp(value = process.env.CUSTOM_DOMAIN_IP ?? "178.236.27.102"): string {
  const raw = (value ?? "").trim();
  // Apex-запись в инструкции — именно A. IPv6 сюда не подставляем: для него нужна AAAA,
  // а молча выдать IPv4-запись с IPv6-адресом означало бы сломать подключение у клиента.
  if (isIP(raw) !== 4) {
    throw new Error("CUSTOM_DOMAIN_IP должен быть публичным IPv4 без порта");
  }
  return raw;
}

export function customDomainsEnabled(): boolean {
  return boolEnv("CUSTOM_DOMAINS_ENABLED");
}

/** Резолверы можно переопределить на стенде; в тестах DNS всегда подменяется. */
export function customDomainDnsServers(): string[] {
  const raw = (process.env.CUSTOM_DOMAIN_DNS_SERVERS ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map(item => item.trim()).filter(Boolean);
}

export function customDomainVerificationHost(hostname: string): string {
  return "_nestdev-verify." + hostname;
}

export function customDomainTargetUrl(hostname: string): string {
  return "https://" + hostname;
}
