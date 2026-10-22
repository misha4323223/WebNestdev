import { createHash, timingSafeEqual } from "node:crypto";
import { getPlatformEnv } from "../platform/platform-env.js";

/**
 * Ключ только для чтения обращений — для отдельной админки (десктопное и мобильное приложение).
 *
 * У внешнего клиента нет cookie сессии панели, поэтому список обращений и скриншоты к ним он
 * забирает по ключу: `Authorization: Bearer <ключ>` или `X-Support-Key: <ключ>`. Ключ даёт ровно
 * чтение — создать обращение по нему нельзя, это делает только форма от имени пользователя.
 *
 * Значение живёт в «Ключах сервера» (группа «Поддержка»), читается через getPlatformEnv и
 * применяется без перезапуска. Короткий ключ не считается настроенным: такой подбирается
 * перебором, а панель уже отдаёт доступ ко всем обращениям.
 */

export const SUPPORT_API_KEY_ENV = "SUPPORT_API_KEY";
export const SUPPORT_API_KEY_HEADER = "x-support-key";
const MIN_KEY_LENGTH = 16;

export type SupportHeaders = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function supportApiKey(): string | null {
  const value = getPlatformEnv(SUPPORT_API_KEY_ENV)?.trim();
  if (!value || value.length < MIN_KEY_LENGTH) return null;
  return value;
}

export function supportKeyFromHeaders(headers: SupportHeaders) {
  const direct = first(headers[SUPPORT_API_KEY_HEADER]);
  if (direct?.trim()) return direct.trim();
  const authorization = first(headers.authorization);
  const match = authorization ? /^Bearer\s+(\S.*)$/i.exec(authorization.trim()) : null;
  return match ? match[1].trim() : null;
}

/**
 * Сравнение по SHA-256: дайджесты одной длины, поэтому timingSafeEqual не выдаёт длину ключа, а
 * само сравнение идёт за постоянное время — перебирать ключ по времени ответа не получится.
 */
export function supportKeyMatches(provided: string | null, expected: string | null) {
  if (!provided || !expected) return false;
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Верно, только если ключ настроен и присланный совпадает с ним. */
export function supportKeyAuthorized(headers: SupportHeaders) {
  return supportKeyMatches(supportKeyFromHeaders(headers), supportApiKey());
}
