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
