import { randomBytes } from "node:crypto";

/**
 * Slug — это DNS-метка и одновременно имя каталога. Сгенерированные адреса остаются
 * 12 строчными hex-символами, но пользователь может выбрать читаемое имя: строчные
 * латинские буквы, цифры и дефис, 3–63 символа.
 *
 * Верхний регистр, `_`, пробелы и полный URL нормализуются до проверки. Всё, что после
 * нормализации не является DNS-меткой, отвергается: `..`, punycode, слэши и подчёркивания
 * не должны попасть ни в DNS, ни в путь на диске.
 */
export const HOSTING_SLUG_LENGTH = 12;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** Служебные метки, которые не должны выглядеть как сайт пользователя. */
const RESERVED = new Set(["www", "api", "admin", "host", "preview", "mail", "smtp", "ftp", "ns1", "ns2"]);

export function isHostingSlug(value: string): boolean {
  return SLUG_RE.test(value) && !RESERVED.has(value) && !value.startsWith("xn--");
}

export function newHostingSlug(): string {
  return randomBytes(HOSTING_SLUG_LENGTH / 2).toString("hex");
}

/**
 * Приводит ввод пользователя к кандидату в slug. Полный URL и домен платформы можно
 * вставить целиком — они снимаются, чтобы поле не заставляло вручную вырезать префикс.
 * Окончательная проверка всё равно одна: `isHostingSlug`.
 */
export function normalizeHostingSlug(value: string, domain?: string) {
  let raw = value.trim().toLowerCase().replace(/\.$/, "");
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  raw = raw.split(/[/?#]/, 1)[0] ?? "";
  raw = raw.replace(/:\d+$/, "");
  if (domain) {
    const suffix = "." + domain.trim().toLowerCase().replace(/\.$/, "");
    if (raw.endsWith(suffix)) raw = raw.slice(0, -suffix.length);
  }
  raw = raw.replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!raw) throw new Error("Введите название сайта");
  if (raw.includes(".")) throw new Error("Укажите только название без домена");
  if (RESERVED.has(raw)) throw new Error("Этот адрес зарезервирован платформой");
  if (!isHostingSlug(raw)) {
    throw new Error("Адрес: 3–63 символа, только латинские буквы, цифры и дефис; начинаться и заканчиваться должен буквой или цифрой");
  }
  return raw;
}

/** Проверка releaseId: его приносит URL при откате, поэтому доверять ему нельзя. */
export function isHostingReleaseId(value: string): boolean {
  return /^[a-f0-9-]{8,64}$/i.test(value);
}

export function assertHostingSlug(value: string) {
  if (!isHostingSlug(value)) throw new Error("Некорректный slug сайта");
  return value;
}

/**
 * `<slug>.<publicDomain>` → slug. Порт и завершающая точка снимаются: Caddy присылает Host
 * с портом, если слушает не 443. Никаких вложенных поддоменов: `a.b.host.example` не сайт.
 */
export function hostSlugForDomain(host: string, domain: string): string | null {
  const normalizedHost = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  const normalizedDomain = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!normalizedHost.endsWith("." + normalizedDomain)) return null;
  const label = normalizedHost.slice(0, -(normalizedDomain.length + 1));
  return isHostingSlug(label) ? label : null;
}

export function assertHostingReleaseId(value: string) {
  if (!isHostingReleaseId(value)) throw new Error("Некорректный идентификатор релиза");
  return value;
}
