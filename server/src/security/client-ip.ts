/**
 * Реальный адрес клиента за обратным прокси.
 *
 * В production перед сервером стоит Caddy, а порт приложения наружу не публикуется. Без `trustProxy`
 * Fastify видит только адрес соединения — адрес контейнера Caddy, один и тот же для всех клиентов.
 * На `request.ip` держатся лимиты входа (`auth/auth-rate-limit.ts`), лимиты кодов SMS и соль для
 * хэша IP в аудите секретов: один общий адрес означал бы, что счётчик попыток входа общий на всю
 * платформу, а аудит не различает источники.
 *
 * Доверять заголовку `X-Forwarded-For` можно только тому, кто его действительно дописывает. Поэтому
 * список прокси задаётся явно (`WEBNESTDEV_TRUSTED_PROXIES`, адреса или CIDR через запятую), а по
 * умолчанию доверяется только loopback: локальная разработка идёт через Vite на 127.0.0.1, а
 * контейнер предпросмотра, дотянувшийся до сервера напрямую, доверенным не станет и подменить адрес
 * не сможет. Compose задаёт адрес Caddy статически и передаёт его сюда.
 */

export const TRUSTED_PROXIES_ENV = "WEBNESTDEV_TRUSTED_PROXIES";
const DEFAULT_TRUSTED = ["127.0.0.1", "::1"];

import { isIP } from "node:net";

/** `::ffff:10.0.0.2` и `[::1]` приводятся к одной форме, чтобы сравнение не зависело от записи. */
export function normalizeAddress(address: string | undefined | null): string {
  const value = (address ?? "").trim();
  if (!value) return "";
  const withoutBrackets = value.replace(/^\[|\]$/g, "");
  return withoutBrackets.toLowerCase().startsWith("::ffff:") ? withoutBrackets.slice(7) : withoutBrackets;
}

/** Список доверенных прокси: значение из окружения, иначе loopback. Пустая строка — тоже loopback. */
export function trustedProxyList(raw = process.env[TRUSTED_PROXIES_ENV]): string[] {
  const values = (raw ?? "")
    .split(",")
    .map(value => normalizeAddress(value))
    .filter(Boolean);
  return values.length ? values : DEFAULT_TRUSTED;
}

function ipv4ToNumber(address: string): number | null {
  const parts = normalizeAddress(address).split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (!numbers.every(number => Number.isFinite(number) && number >= 0 && number <= 255)) return null;
  return ((numbers[0] << 24) | (numbers[1] << 16) | (numbers[2] << 8) | numbers[3]) >>> 0;
}

/** 100.64.0.0/10 — CGNAT: за одним адресом стоят разные люди, IP не является личностью. */
export function isCgnatAddress(address: string): boolean {
  const value = ipv4ToNumber(address);
  return value !== null && value >= 0x64400000 && value <= 0x647fffff;
}

function ipv6Words(address: string): number[] | null {
  const value = normalizeAddress(address).split("%")[0]!;
  if (isIP(value) !== 6) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const words: number[] = [];
    for (const token of half.split(":")) {
      if (token.includes(".")) {
        const ipv4 = ipv4ToNumber(token);
        if (ipv4 === null) return null;
        words.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      words.push(parseInt(token, 16));
    }
    return words;
  };
  const head = parseHalf(halves[0] ?? "");
  const tail = halves.length === 2 ? parseHalf(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  if (head.length + tail.length >= 8) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * Ключ IP-двери лимитов.
 *
 * IPv6 сворачивается до /64: клиент обычно получает целую подсеть, и перебор с разных адресов
 * одной /64 не должен получать новое окно на каждый адрес. CGNAT (100.64.0.0/10) не даёт ключа:
 * за ним тысячи честных людей, поэтому IP-дверь для него пропускается, а лимиты по аккаунту/email
 * продолжают работать. Обычный IPv4 остаётся точным адресом.
 */
export type RateLimitAddress = { key: string; cgnat: boolean };
export function rateLimitAddress(address: string | undefined | null): RateLimitAddress {
  const value = normalizeAddress(address);
  if (!value) return { key: "unknown", cgnat: false };
  if (isCgnatAddress(value)) return { key: "cgnat", cgnat: true };
  const words = ipv6Words(value);
  if (words) {
    const prefix = words.slice(0, 4).map(word => word.toString(16)).join(":");
    return { key: prefix + "::/64", cgnat: false };
  }
  return { key: value, cgnat: false };
}

/**
 * Адрес в диапазоне. Поддерживаются точный адрес, IPv4-CIDR и точный IPv6: сетка Docker здесь
 * всегда IPv4, а IPv6 нужен только для `::1`.
 */
export function addressInRange(address: string, range: string): boolean {
  const target = normalizeAddress(address);
  const entry = normalizeAddress(range);
  if (!target || !entry) return false;
  const slash = entry.indexOf("/");
  if (slash < 0) return target === entry;
  const base = entry.slice(0, slash);
  const bits = Number(entry.slice(slash + 1));
  const network = ipv4ToNumber(base);
  const candidate = ipv4ToNumber(target);
  if (network === null || candidate === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (network & mask) >>> 0 === (candidate & mask) >>> 0;
}

export function isTrustedProxy(address: string | undefined | null, list = trustedProxyList()): boolean {
  const value = normalizeAddress(address);
  if (!value) return false;
  return list.some(range => addressInRange(value, range));
}

/**
 * Значение для `Fastify({trustProxy})`. Функция, а не `true`: `true` доверяет заголовку от кого
 * угодно, и тогда лимиты обходятся одним лишним заголовком.
 */
export function trustProxyOption(list = trustedProxyList()): false | ((address: string) => boolean) {
  if (!list.length) return false;
  return (address: string) => isTrustedProxy(address, list);
}

/** Строка для журнала старта: по ней видно, откуда сервер берёт адрес клиента. */
export function describeTrustProxy(list = trustedProxyList()): string {
  return "адрес клиента: доверенные прокси " + list.join(", ") + " — request.ip берётся из X-Forwarded-For только от них";
}
