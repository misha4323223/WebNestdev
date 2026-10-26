import { createHash, timingSafeEqual } from "node:crypto";
import { getPlatformEnv, normalizeApiKeyValue, platformEnvSetByPanel, refreshPlatformEnv } from "../platform/platform-env.js";

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
  const value = getPlatformEnv(SUPPORT_API_KEY_ENV);
  if (!value) return null;
  // Пробелы и невидимые символы не делают ключ другим — они делают его нерабочим.
  const key = normalizeApiKeyValue(value);
  if (key.length < MIN_KEY_LENGTH) return null;
  return key;
}

/** Откуда взято значение: панель важнее окружения, окружение — важнее «не задан». */
export function supportKeySource(): "panel" | "environment" | "none" {
  if (platformEnvSetByPanel(SUPPORT_API_KEY_ENV)) return "panel";
  if (process.env[SUPPORT_API_KEY_ENV]?.trim()) return "environment";
  return "none";
}

/**
 * Состояние без самого значения: его достаточно, чтобы отличить «ключ не сохранён» от
 * «ключ сохранён, но слишком короткий» и «панель пишет, а запрос идёт в другой процесс».
 */
export function supportKeyStatus() {
  const value = getPlatformEnv(SUPPORT_API_KEY_ENV)?.trim();
  return {
    keySource: supportKeySource(),
    keyConfigured: Boolean(value),
    keyUsable: supportApiKey() !== null,
  };
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
  const leftValue = normalizeApiKeyValue(provided);
  const rightValue = normalizeApiKeyValue(expected);
  if (!leftValue || !rightValue) return false;
  const left = createHash("sha256").update(leftValue, "utf8").digest();
  const right = createHash("sha256").update(rightValue, "utf8").digest();
  return timingSafeEqual(left, right);
}

/** Верно, только если ключ настроен и присланный совпадает с ним. */
export function supportKeyAuthorized(headers: SupportHeaders) {
  return supportKeyMatches(supportKeyFromHeaders(headers), supportApiKey());
}

/**
 * Та же проверка, но перед ней память сверяется с файлом: так ключ, сохранённый в панели на
 * другой реплике (или другим процессом), начинает работать без перезапуска и без ожидания.
 */
export async function supportKeyAuthorizedCurrent(headers: SupportHeaders) {
  await refreshPlatformEnv();
  return supportKeyAuthorized(headers);
}
