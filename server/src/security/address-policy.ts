import { isIP } from "node:net";

/**
 * Классификация сетевых адресов для мест, где платформа запускает чужой код: serverless-функции,
 * Chromium и контейнеры предпросмотра.
 *
 * Правило одно: публичный адрес разрешён, всё специальное — private, loopback, link-local,
 * CGNAT, multicast, documentation и IPv4-mapped — запрещено. Так код проекта не может обратиться
 * к API платформы, PostgreSQL, Docker-сокету через сеть или к metadata облака, но обычные внешние
 * API и CDN продолжают работать.
 *
 * Проверка намеренно не делает DNS-запрос: для имён сначала нужно получить адрес, а затем
 * проверить каждый ответ. Иначе DNS rebinding успел бы подменить адрес между проверкой и
 * соединением.
 */

export type IpFamily = 4 | 6;

/** IPv4-диапазоны, которые не являются обычным публичным интернетом. */
const IPV4_BLOCKED: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 — «этот хост»
  [0x0a000000, 8], // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 — CGNAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 — link-local и metadata
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24 — IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 — TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 — 6to4 relay
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15 — benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 — TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 — TEST-NET-3
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved, включая 255.255.255.255
];

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = value * 256 + number;
  }
  return value;
}

function ipv4Blocked(value: number): boolean {
  return IPV4_BLOCKED.some(([network, bits]) => {
    const size = 2 ** (32 - bits);
    return Math.floor(value / size) === Math.floor(network / size);
  });
}

/** IPv6 в BigInt. Поддерживает `::`, полную и сжатую запись, но не зону интерфейса. */
function parseIpv6(address: string): bigint | null {
  const raw = address.toLowerCase().split("%")[0]!;
  if (!raw.includes(":")) return null;
  // IPv6 может заканчиваться точечной записью IPv4 (`::ffff:127.0.0.1`). Без этого разбора
  // такая запись считалась бы «неразбираемой» и блокировалась целиком — безопасно, но тогда
  // нельзя отличить публичный mapped-адрес от приватного. Заменяем хвост двумя hex-группами.
  let normalized = raw;
  if (raw.includes(".")) {
    const lastColon = raw.lastIndexOf(":");
    if (lastColon < 0) return null;
    const embedded = parseIpv4(raw.slice(lastColon + 1));
    if (embedded === null) return null;
    normalized = raw.slice(0, lastColon + 1) +
      (embedded >>> 16).toString(16) + ":" + (embedded & 0xffff).toString(16);
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function ipv6Blocked(value: bigint): boolean {
  const prefix = (bits: number) => value >> BigInt(128 - bits);
  // ::/128 и ::1/128
  if (value === 0n || value === 1n) return true;
  // ::ffff:0:0/96 — IPv4-mapped. Проверять нужно вложенный IPv4, а не только внешний вид.
  if (prefix(96) === 0xffffn) {
    const embedded = Number(value & 0xffffffffn);
    return ipv4Blocked(embedded);
  }
  // ::ffff:0:0/96 — IPv4-translated (RFC 2765): тот же вложенный IPv4, но другая позиция.
  // Закрываем целиком: иначе `::ffff:0:127.0.0.1` выглядел бы публичным IPv6.
  if (prefix(96) === 0xffff0000n) return true;
  // ::/96 — IPv4-compatible (устаревший, но всё ещё позволяет добраться до 127.0.0.1).
  if (prefix(96) === 0n) return true;
  // 64:ff9b::/96 — well-known NAT64; 64:ff9b:1::/48 — локальный NAT64; 100::/64 — discard.
  // NAT64 может привести к встроенному IPv4, поэтому оба префикса закрыты целиком.
  if (prefix(96) === 0x0064ff9b0000000000000000n) return true;
  if (prefix(48) === 0x0064ff9b0001n) return true;
  if (prefix(64) === 0x0100000000000000n) return true;
  // 2002::/16 — 6to4: адрес содержит IPv4 и может вести на private-сеть через relay.
  if (prefix(16) === 0x2002n) return true;
  // 2001::/32 — Teredo: туннель к IPv4-адресу.
  if (prefix(32) === 0x20010000n) return true;
  // 2001:db8::/32 и 2001:2::/48 — документация и benchmark.
  if (prefix(32) === 0x20010db8n) return true;
  if (prefix(48) === 0x200100020000n) return true;
  // 2001:10::/28 — ORCHID; 2001:20::/28 — ORCHIDv2.
  if (prefix(28) === 0x2001001n) return true;
  if (prefix(28) === 0x2001002n) return true;
  // fc00::/7 — unique local; fe80::/10 — link-local; fec0::/10 — deprecated site-local.
  if (prefix(7) === 0x7en) return true;
  if (prefix(10) === 0x3fan) return true;
  if (prefix(10) === 0x3fbn) return true;
  // ff00::/8 — multicast.
  if (prefix(8) === 0xffn) return true;
  return false;
}

/** IP-литерал ли это (без имени). Зона IPv6 (`%eth0`) допускается. */
export function isIpLiteral(value: string): boolean {
  return isIP(value.split("%")[0]!) !== 0;
}

/**
 * `true`, если адрес нельзя использовать для выхода в обычный интернет. Для имени функция
 * возвращает `false`: имя сначала нужно разрешить и проверить каждый полученный адрес.
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim();
  if (!value) return false;
  if (isIP(value.split("%")[0]!) === 4) {
    const parsed = parseIpv4(value);
    return parsed === null ? true : ipv4Blocked(parsed);
  }
  if (isIP(value.split("%")[0]!) === 6) {
    const parsed = parseIpv6(value);
    return parsed === null ? true : ipv6Blocked(parsed);
  }
  return false;
}

/** Публичный адрес — только валидный IP-литерал вне специальных диапазонов. */
export function isPublicAddress(address: string): boolean {
  return isIpLiteral(address) && !isPrivateAddress(address);
}
