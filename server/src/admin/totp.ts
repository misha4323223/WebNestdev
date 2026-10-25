import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP для входа администратора: второй фактор, который живёт в приложении-аутентификаторе.
 *
 * Библиотека не подключена сознательно. TOTP — это HMAC-SHA1 от номера тридцатисекундного шага,
 * восемьдесят строк на `node:crypto`; новая зависимость в цепочке входа администратора означала бы,
 * что чужая ошибка или подмена пакета открывает платформу целиком. Здесь же весь код читается одним
 * экраном и проверяется официальными векторами RFC 6238 (`totp.test.ts`).
 *
 * Секрет хранится в base32 без выравнивания — так его принимают аутентификаторы и так его можно
 * набрать руками. В базе он лежит зашифрованным (см. admin-store.ts), а не открытым текстом.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Длина шага TOTP в секундах: значение по умолчанию из RFC 6238. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_STEP_MS = TOTP_PERIOD_SECONDS * 1000;
/** Сколько цифр показывает аутентификатор. */
export const TOTP_DIGITS = 6;
/**
 * Допуск по шагам: один шаг назад и один вперёд.
 *
 * Часы телефона и сервера не совпадают идеально, а без допуска вход ломался бы на границе шага.
 * Больше одного шага в каждую сторону — это уже не «расхождение часов», а окно для перебора.
 */
export const TOTP_WINDOW = 1;
/** Сколько одноразовых кодов восстановления выдаётся при подключении фактора. */
export const RECOVERY_CODE_COUNT = 10;

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Разбор base32. Пробелы, переводы строк и дефисы допускаются: секрет показывают группами по четыре
 * символа, и человек копирует его именно так. Любой другой символ — ошибка, а не «пропустим»:
 * молча отброшенный символ дал бы другой секрет и необъяснимый отказ кода.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  if (!clean) throw new Error("Пустой секрет TOTP");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Секрет TOTP не в base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Новый секрет: 160 бит — то, что рекомендуют для TOTP (20 байт → 32 символа base32). */
export function generateTotpSecret(size = 20): string {
  return base32Encode(randomBytes(size));
}

/** HOTP: HMAC-SHA1 от счётчика и усечение по RFC 4226. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(counter))));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(value % 10 ** digits).padStart(digits, "0");
}

/** Номер текущего шага: именно он, а не время, записывается как «последний использованный». */
export function totpStep(atMs = Date.now()): number {
  return Math.floor(atMs / TOTP_STEP_MS);
}

export function totp(secretBase32: string, atMs = Date.now(), digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpStep(atMs), digits);
}

export type TotpMatch = { step: number };

function sameString(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Проверка кода с допуском по шагам.
 *
 * `afterStep` — защита от повторного использования уже принятого кода: код живёт весь свой шаг, и
 * без этой проверки подсмотренный код можно было бы предъявить второй раз в его же окне. Значение
 * хранится в записи администратора (`lastTotpStep`).
 */
export function matchTotp(
  secretBase32: string,
  code: string,
  options: { atMs?: number; digits?: number; window?: number; afterStep?: number } = {},
): TotpMatch | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const window = options.window ?? TOTP_WINDOW;
  const normalized = (code ?? "").replace(/[\s-]/g, "");
  if (!new RegExp("^\\d{" + digits + "}$").test(normalized)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  if (!secret.length) return null;
  const center = totpStep(options.atMs ?? Date.now());
  for (let offset = -window; offset <= window; offset++) {
    const step = center + offset;
    if (step < 0) continue;
    if (options.afterStep !== undefined && step <= options.afterStep) continue;
    if (sameString(hotp(secret, step, digits), normalized)) return { step };
  }
  return null;
}

/** Ссылка для аутентификатора: по ней приложение само считает коды. */
export function otpauthUri(input: {
  issuer: string;
  account: string;
  secret: string;
  digits?: number;
  period?: number;
}): string {
  const label = encodeURIComponent(input.issuer) + ":" + encodeURIComponent(input.account);
  const params = [
    "secret=" + encodeURIComponent(input.secret),
    "issuer=" + encodeURIComponent(input.issuer),
    "algorithm=SHA1",
    "digits=" + String(input.digits ?? TOTP_DIGITS),
    "period=" + String(input.period ?? TOTP_PERIOD_SECONDS),
  ].join("&");
  return "otpauth://totp/" + label + "?" + params;
}

/**
 * Одноразовые коды восстановления.
 *
 * Они нужны ровно на один случай — телефон потерян. Поэтому это не TOTP-секрет и не пароль, а
 * десять независимых значений примерно по 50 бит: такой код нельзя подобрать, но его можно один раз
 * продиктовать с экрана, где он сохранён.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return raw.slice(0, 5) + "-" + raw.slice(5);
  });
}

/** Приведение кода к сравнимому виду: регистр, дефисы и пробелы не должны решать, подойдёт ли код. */
export function normalizeRecoveryCode(code: string): string {
  return (code ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "");
}

/**
 * Хранится только хеш (sha256): код восстановления — это второй пароль, и база не должна давать
 * возможности войти по её копии. Соль не нужна: у кода 50 бит энтропии, радужных таблиц на такое
 * пространство нет, а быстрый поиск по хешу позволяет проверить предъявленный код за один проход.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

/** Индекс подошедшего кода или -1. Сравнение по всем записям, чтобы время ответа не выдавало номер. */
export function matchRecoveryCode(hashes: string[], code: string): number {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return -1;
  const candidate = Buffer.from(hashRecoveryCode(normalized), "hex");
  let found = -1;
  hashes.forEach((stored, index) => {
    const value = Buffer.from(stored, "hex");
    if (value.length === candidate.length && timingSafeEqual(value, candidate) && found < 0) found = index;
  });
  return found;
}
