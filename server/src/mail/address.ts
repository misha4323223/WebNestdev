/**
 * Адреса для исходящих писем: что вообще можно отправлять.
 *
 * Логин аккаунта и почтовый ящик — разные вещи. Вход по телефону и по Яндекс ID создаёт служебный
 * адрес вида `79531814136@phone.webnestdev.local`: он нужен хранилищу как уникальный
 * идентификатор, но письмо на него уйдёт в никуда и вернётся отскоком. Отскоки расходуют квоту
 * Postbox и портят репутацию домена, поэтому служебные адреса отсекаются до очереди, а не после
 * первой ошибки отправки.
 */

/** Служебные домены и зоны, которые не могут принимать почту. */
const SERVICE_DOMAINS = [".local", ".internal", ".invalid", ".test", ".example", ".localhost", ".lan", ".home"];

/** Адрес без пробелов и запятых с непустыми частями: точную проверку домена делает вызывающий. */
const EMAIL_PATTERN = /^[^@\s,]+@[^@\s,]+$/;

/** Нижний регистр и обрезка пробелов: адрес для сравнения, а не для показа. */
export function normalizeEmail(email: string | null | undefined) {
  return (email ?? "").trim().toLowerCase();
}

/** Домен адреса; пустая строка, если разделителя нет. */
export function emailDomain(email: string) {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1);
}

/**
 * Служебный ли это адрес: `79531814136@phone.webnestdev.local` и подобные. Отдельная функция,
 * потому что об этом спрашивают не только при отправке: админка показывает вид адреса в тикете
 * (`emailKind`) и не подставляет служебный адрес в поле «почта для связи».
 */
export function isServiceEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(normalizeEmail(email));
  return Boolean(domain) && SERVICE_DOMAINS.some(zone => domain === zone.slice(1) || domain.endsWith(zone));
}

/**
 * Годится ли адрес для отправки. Причина отказа возвращается текстом: админке нужно показать,
 * почему адрес выброшен, а не просто уменьшить число получателей.
 *
 * Служебный домен проверяется раньше общего «не похож на почтовый»: `79531814136@phone.webnestdev.local`
 * с виду настоящий адрес, и «не похож» скрыло бы настоящую причину — это логин платформы, письмо
 * на него уйдёт отскоком.
 */
export function unusableEmailReason(email: string | null | undefined): string | null {
  const value = normalizeEmail(email);
  if (!value) return "адрес пустой";
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return "адрес не похож на почтовый";
  if (!EMAIL_PATTERN.test(value)) return "адрес не похож на почтовый";
  const domain = emailDomain(value);
  if (isServiceEmail(value)) return "служебный домен платформы (" + domain + ") — письмо некуда доставить";
  if (!domain.includes(".")) return "домен без точки";
  return null;
}

/** Короткий вид адреса для логов и предупреждений: целиком писать в лог нечего. */
export function maskEmail(email: string) {
  const value = normalizeEmail(email);
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  return (local.length <= 2 ? local[0] ?? "" : local.slice(0, 2)) + "***@" + value.slice(at + 1);
}
