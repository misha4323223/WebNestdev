import { clearRateLimits, consumeRateLimit } from "../storage/rate-limit-store.js";

/**
 * Лимиты попыток входа, регистрации и кодов.
 *
 * Сколько попыток разрешено — это правило продукта и живёт здесь; *где* считаются попытки — в
 * `storage/rate-limit-store.ts`. Раньше счётчики были `Map` в памяти процесса: выкатка обнуляла
 * окна, а вторая реплика API считала всё заново. Теперь окно одно на платформу.
 *
 * Две двери считаются всегда: адрес и аккаунт. Адрес останавливает веер по аккаунтам, аккаунт —
 * перебор с разных адресов. За прокси одного адреса мало: все пришли бы с одного IP.
 */

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

const WINDOW_MS = 15 * 60 * 1000;

export type AuthAction =
  | "login"
  | "register"
  | "phone"
  | "phoneVerify"
  | "phoneDemo"
  | "emailVerification"
  | "emailVerify"
  /** Запрос письма восстановления пароля: по адресу и по аккаунту. */
  | "passwordReset"
  /** Переход по ссылке восстановления: токен длинный, но попытки всё равно считаем. */
  | "passwordResetConfirm"
  | "adminLogin"
  | "adminTotp";

/** Попытки с одного адреса: грубая защита, не зависящая от того, какой аккаунт перебирают. */
const IP_LIMITS: Record<AuthAction, number> = {
  login: 12,
  register: 6,
  phone: 10,
  phoneVerify: 30,
  phoneDemo: 60,
  emailVerification: 6,
  emailVerify: 12,
  passwordReset: 6,
  passwordResetConfirm: 20,
  // Вход администратора: адресов меньше, чем пользователей, но и попыток должно хватать на смену.
  adminLogin: 20,
  adminTotp: 30,
};

/**
 * Попытки по одному аккаунту. Без этого распределённый перебор с разных адресов не встречал бы
 * сопротивления, а один общий счётчик на IP позволял бы блокировать вход всем сразу.
 */
const SUBJECT_LIMITS: Record<AuthAction, number> = {
  login: 8,
  register: 4,
  phone: 4,
  phoneVerify: 15,
  phoneDemo: 60,
  emailVerification: 3,
  emailVerify: 8,
  passwordReset: 3,
  // У подтверждения сброса нет email в теле: счётчик только по адресу запроса.
  passwordResetConfirm: 20,
  adminLogin: 10,
  adminTotp: 20,
};

/**
 * Проверка: адрес, затем аккаунт. `subject` — нормализованный email или телефон; он необязателен,
 * потому что запрос без валидного тела ещё не знает, кого перебирают.
 *
 * Ошибка хранилища не запирает вход: `consumeRateLimit` в этом случае пропускает, а причина
 * остаётся в логе. Иначе недоступная база превращалась бы в «войти нельзя никому».
 */
export async function checkAuthRateLimit(ip: string, action: AuthAction, subject?: string): Promise<RateLimitResult> {
  // Коды SMS дополнительно ограничены по номеру внутри phone-store (сколько отправок и попыток),
  // а здесь — счётчики адреса и аккаунта: они отвечают на «кто и кого перебирает».
  const byIp = await consume("ip:" + action + ":" + (ip || "unknown"), IP_LIMITS[action]);
  if (!byIp.allowed) return { allowed: false, retryAfter: byIp.retryAfter };

  const normalized = subject?.trim().toLowerCase();
  if (normalized) {
    const bySubject = await consume("subject:" + action + ":" + normalized, SUBJECT_LIMITS[action]);
    if (!bySubject.allowed) return { allowed: false, retryAfter: bySubject.retryAfter };
  }
  return { allowed: true };
}

async function consume(key: string, limit: number) {
  try {
    return await consumeRateLimit(key, limit, WINDOW_MS);
  } catch (error) {
    console.warn(
      "[auth] счётчик попыток недоступен, проверка лимита пропущена: " +
        (error instanceof Error ? error.message : String(error)),
    );
    return { allowed: true, retryAfter: 0 };
  }
}

/** Сброс окон: тесты начинают с чистых счётчиков, администратор — при разборе блокировки. */
export async function clearAuthRateLimits(): Promise<void> {
  await clearRateLimits();
}
