/**
 * Вход по номеру телефона выключен по умолчанию.
 *
 * SMS — платный канал, и на проде он был отключён. Код входа и провайдеры остаются в
 * репозитории, чтобы вернуть возможность позже: для этого достаточно задать
 * `PHONE_AUTH_ENABLED=1` и ключи провайдера. Без флага маршруты `/api/auth/phone/*`
 * не создают коды, не пишут телефонные аккаунты и не отправляют SMS.
 */
const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export function phoneAuthEnabled() {
  const raw = process.env.PHONE_AUTH_ENABLED?.trim().toLowerCase();
  return raw ? ENABLED_VALUES.has(raw) : false;
}

export const PHONE_AUTH_DISABLED_MESSAGE = "Вход по номеру телефона отключён.";
