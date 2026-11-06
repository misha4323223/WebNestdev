import { isIP } from "node:net";
import type { EgressMode } from "./config.js";

/**
 * Правила фильтра исходящей сети (пункт 5.1 плана масштабирования).
 *
 * Здесь нет ни сокетов, ни таймеров — только решение по паре «домен, порт, адрес». Поэтому правила
 * проверяются тестами без сети и без Docker, а прокси (egress/proxy.ts) остаётся пересылкой.
 *
 * Порядок проверок важен и объясняет приоритет: сначала адрес (metadata, приватная сеть), потом
 * режим. Приватные адреса закрыты и в `private-only`, и в `allowlist`: разрешённый домен не должен
 * становиться лазейкой в нашу же сеть, если он резолвится в 127.0.0.1 или 10/8 (DNS-rebinding,
 * подмена DNS, свой домен заказчика с A-записью внутрь).
 */

export type EgressDenyReason = "bad-host" | "bad-port" | "metadata" | "private" | "not-allowlisted";

export type EgressDecision = { allowed: true } | { allowed: false; reason: EgressDenyReason };

export type EgressCheckOptions = {
  mode: Exclude<EgressMode, "off">;
  allowlist?: string[];
  ports?: number[];
};

/**
 * Разрешённые по умолчанию адреса. Это минимум, при котором обычный проект ставится и собирается:
 * реестры пакетов, git-хостинги, типовые CDN и шрифты. Список расширяется через `EGRESS_ALLOWLIST`
 * (через запятую). Сознательно не включены: любые API-домены заказчиков, telegram/smtp-хосты,
 * сервисы с оплатой — это решается отдельно, а не «на всякий случай».
 */
const DEFAULT_ALLOWLIST = [
  // npm, yarn, pnpm
  "registry.npmjs.org",
  "*.npmjs.org",
  "*.npmjs.com",
  "registry.yarnpkg.com",
  "*.yarnpkg.com",
  "nodejs.org",
  "*.nodejs.org",
  // git-хостинги (по https: ssh мимо прокси и закрыт)
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "gitverse.ru",
  "*.gitverse.ru",
  // python и ruby (нужны сборкам нативных зависимостей)
  "pypi.org",
  "files.pythonhosted.org",
  "*.pythonhosted.org",
  "*.rubygems.org",
  // CDN фронтенда
  "*.jsdelivr.net",
  "*.unpkg.com",
  "*.esm.sh",
  "*.skypack.dev",
  "*.bootstrapcdn.com",
  "*.cloudflare.com",
  "*.fastly.net",
  // шрифты и карты Google
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "*.googleapis.com",
  "*.gstatic.com",
];

/** Адреса, по которым облако отдаёт метаданные инстанса: токены и профиль самой ВМ. */
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);
const METADATA_ADDRESSES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "100.100.100.200",
  "fd00:ec2::254",
  "::ffff:169.254.169.254",
]);

/** Домены без завершающей точки, в нижнем регистре; `null` — это не домен. */
export function normalizeEgressHost(host: string): string | null {
  const value = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!value) return null;
  // Кириллица в имени хоста — почти всегда мусор из заголовка, а не адрес. Звёздочка нужна
  // шаблонам allowlist (`*.npmjs.org`): та же нормализация, что и у имени, иначе шаблон не совпадёт.
  if (!/^[a-z0-9.*_:-]+$/.test(value)) return null;
  if (value.length > 253) return null;
  return value;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(value: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  const start = ipv4ToInt(base);
  if (start === null) return false;
  return (value & mask) === (start & mask);
}

/**
 * Приватные и «служебные» IPv4/IPv6. Кроме RFC1918 сюда входят loopback, link-local (там же
 * metadata), CGNAT, broadcast/multicast и зарезервированные диапазоны: всё это либо наша
 * инфраструктура, либо адреса, на которые контейнеру ходить незачем.
 */
export function isPrivateAddress(address: string): boolean {
  const value = (address ?? "").trim().toLowerCase();
  const mapped = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  const version = isIP(mapped);
  if (version === 4) {
    const number = ipv4ToInt(mapped);
    if (number === null) return true;
    if (number === 0) return true;
    return (
      inCidr(number, "0.0.0.0", 8) ||
      inCidr(number, "10.0.0.0", 8) ||
      inCidr(number, "100.64.0.0", 10) ||
      inCidr(number, "127.0.0.0", 8) ||
      inCidr(number, "169.254.0.0", 16) ||
      inCidr(number, "172.16.0.0", 12) ||
      inCidr(number, "192.0.0.0", 24) ||
      inCidr(number, "192.168.0.0", 16) ||
      inCidr(number, "198.18.0.0", 15) ||
      inCidr(number, "224.0.0.0", 4) ||
      inCidr(number, "240.0.0.0", 4)
    );
  }
  if (version === 6) {
    if (mapped === "::" || mapped === "::1") return true;
    // IPv4-mapped уже развёрнут выше; остальное — ULA, link-local, multicast.
    return /^f[cd][0-9a-f]{2}:/.test(mapped) || /^fe[89ab][0-9a-f]:/.test(mapped) || /^ff[0-9a-f]{2}:/.test(mapped);
  }
  // Не адрес вовсе — вызывающий обязан был прислать адрес; в фильтре это «не пускать».
  return true;
}

export function isMetadataAddress(address: string, host = ""): boolean {
  const value = (address ?? "").trim().toLowerCase();
  const name = normalizeEgressHost(host);
  if (name && METADATA_HOSTS.has(name)) return true;
  return METADATA_ADDRESSES.has(value);
}

/**
 * `*.example.com` — поддомены (сам `example.com` не покрывается, его перечисляют отдельно),
 * `example.com` — ровно этот домен. Регулярные выражения не поддерживаются намеренно: шаблон
 * в allowlist должен читаться глазами, а не разбираться.
 */
export function hostMatches(host: string, pattern: string): boolean {
  const name = normalizeEgressHost(host);
  const rule = normalizeEgressHost(pattern);
  if (!name || !rule) return false;
  if (rule.startsWith("*.")) return name.endsWith(rule.slice(1)) && name.length > rule.length - 1;
  return name === rule;
}

export function hostAllowlisted(host: string, patterns: string[]): boolean {
  return patterns.some(pattern => hostMatches(host, pattern));
}

export function defaultEgressAllowlist(): string[] {
  return [...DEFAULT_ALLOWLIST];
}

/**
 * Итоговый allowlist: встроенный минимум плюс `EGRESS_ALLOWLIST` (через запятую или пробел).
 * Дополнять, а не заменять: замена означала бы, что достаточно опечатки в `.env`, чтобы отключить
 * установку пакетов во всех проектах сразу и не заметить этого по коду.
 */
export function egressAllowlist(raw: string | undefined = process.env.EGRESS_ALLOWLIST): string[] {
  const extra = (raw ?? "")
    .split(/[,\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWLIST, ...extra])];
}

/**
 * Решение по одному соединению. `address` — уже разрешённый адрес: прокси соединяется именно с
 * ним, поэтому проверка и соединение не могут разойтись (иначе DNS-rebinding обходил бы фильтр).
 */
export function checkEgress(host: string, port: number, address: string, options: EgressCheckOptions): EgressDecision {
  const name = normalizeEgressHost(host);
  if (!name) return { allowed: false, reason: "bad-host" };
  const allowedPorts = options.ports ?? [80, 443];
  if (!allowedPorts.includes(port)) return { allowed: false, reason: "bad-port" };
  // Литеральный IP в URL: имя хоста и есть адрес, разрешать его отдельно не нужно.
  const target = isIP(name) ? name : (address ?? "").trim();
  if (!target) return { allowed: false, reason: "bad-host" };
  if (isMetadataAddress(target, name)) return { allowed: false, reason: "metadata" };
  if (isPrivateAddress(target)) return { allowed: false, reason: "private" };
  if (options.mode === "private-only") return { allowed: true };
  if (hostAllowlisted(name, options.allowlist ?? DEFAULT_ALLOWLIST)) return { allowed: true };
  return { allowed: false, reason: "not-allowlisted" };
}

/** Пояснение для человека: одна и та же фраза в логе, в ответе прокси и в панели. */
export function describeEgressDeny(reason: EgressDenyReason, host: string): string {
  switch (reason) {
    case "metadata":
      return "адреса метаданных облака запрещены: " + host;
    case "private":
      return "приватные адреса и внутренняя сеть платформы запрещены: " + host;
    case "bad-port":
      return "разрешены только порты 80 и 443: " + host;
    case "not-allowlisted":
      return "домен не входит в список разрешённых: " + host;
    default:
      return "некорректный адрес: " + host;
  }
}
