import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Общий секрет API и двери предпросмотра, когда дверь работает отдельным процессом
 * (`PREVIEW_DOOR_SEPARATE=1`, см. preview/door-main.ts).
 *
 * Дверь отдаёт байты приложения клиенту, но состояние предпросмотра (какой контейнер, на каком
 * порту, жив ли он) живёт в памяти процесса API: карта `preview-store` не переживает разделение.
 * Поэтому дверь спрашивает API по внутреннему адресу — и этот запрос обязан быть закрыт от
 * публики, хотя бы потому что Caddy проксирует `/api/*` наружу.
 *
 * Отдельного секрета для этого не заводим: значение выводится из ключа шифрования, который оба
 * процесса уже получают из окружения. Ротация ключа меняет и токен, а хранить и передавать
 * больше нечего — новой переменной в `.env` на ВМ, где нет терминала, не появляется.
 *
 * Токен не равен ключу: HMAC по назначению не даёт использовать его как ключ расшифровки, даже
 * если он утечёт из заголовка в лог.
 */

const PURPOSE = "preview-door:v1";
const ENV_NAME = "WEBNESTDEV_ENCRYPTION_KEY";

/** Ключ, из которого выводится токен; `null` — окружение не настроено (production так не стартует). */
export function previewDoorKey(): string | null {
  const raw = (process.env[ENV_NAME] ?? "").trim();
  return raw || null;
}

/** Токен двери; `null` — выводить не из чего, и внутренний маршрут отвечает 503. */
export function previewDoorToken(key: string | null = previewDoorKey()): string | null {
  if (!key) return null;
  return createHmac("sha256", key).update(PURPOSE).digest("hex");
}

/**
 * Сверка заголовка `Authorization` с ожидаемым токеном. Сравнение постоянного времени: длина у
 * дайджеста фиксированная, поэтому `timingSafeEqual` не выдаёт, на каком байте разошлось.
 */
export function previewDoorTokenValid(header: string | undefined | null, expected: string | null = previewDoorToken()): boolean {
  if (!expected) return false;
  const value = (header ?? "").trim();
  const prefix = "bearer ";
  const token = value.slice(0, prefix.length).toLowerCase() === prefix ? value.slice(prefix.length).trim() : "";
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(expected, "utf8"));
}
