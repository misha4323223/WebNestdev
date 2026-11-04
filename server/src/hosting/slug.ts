import { randomBytes } from "node:crypto";

/**
 * Slug — это DNS-метка и одновременно имя каталога. Поэтому он не может быть выбран
 * пользователем: только строчные hex-символы фиксированной длины. Так исключены `..`,
 * punycode, подчёркивания, верхний регистр и любые вопросы нормализации DNS.
 */
export const HOSTING_SLUG_LENGTH = 12;
const SLUG_RE = /^[a-f0-9]{12}$/;

/** Служебные метки, которые не должны выглядеть как сайт пользователя. */
const RESERVED = new Set(["www", "api", "admin", "host", "preview", "mail", "smtp", "ftp", "ns1", "ns2"]);

export function isHostingSlug(value: string): boolean {
  return SLUG_RE.test(value) && !RESERVED.has(value);
}

export function newHostingSlug(): string {
  return randomBytes(HOSTING_SLUG_LENGTH / 2).toString("hex");
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
