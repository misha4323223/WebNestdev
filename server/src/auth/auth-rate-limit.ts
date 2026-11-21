import { clearRateLimits, consumeRateLimit } from "../storage/rate-limit-store.js";
import { rateLimitAddress } from "../security/client-ip.js";

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
 * Действия, для которых недоступное хранилище счётчиков — отказ, а не пропуск. Это двери с
 * высокой ценой ошибки: вход администратора, второй фактор, сброс пароля и регистрация. SMS-коды
 * сюда не входят: их отдельные счётчики живут в phone-store, и менять SMS-контур мы не хотим.
 */
const FAIL_CLOSED_ACTIONS: ReadonlySet<AuthAction> = new Set([
  "register",
  "passwordReset",
  "passwordResetConfirm",
  "adminLogin",
  "adminTotp",
]);

/**
 * Проверка: адрес, затем аккаунт. `subject` — нормализованный email или телефон; он необязателен,
 * потому что запрос без валидного тела ещё не знает, кого перебирают.
 *
 * Для обычного входа ошибка хранилища по-прежнему пропускает попытку: недоступная база не должна
 * запирать всех. Для admin/TOTP/password reset/register — наоборот, отказ: иначе отказ базы
 * превращает защиту от перебора в открытую дверь. SMS-действия оставлены на прежнем режиме.
 */
export async function checkAuthRateLimit(ip: string, action: AuthAction, subject?: string): Promise<RateLimitResult> {
  // Коды SMS дополнительно ограничены по номеру внутри phone-store (сколько отправок и попыток),
  // а здесь — счётчики адреса и аккаунта: они отвечают на «кто и кого перебирает».
  const network = rateLimitAddress(ip);
  // CGNAT — общий адрес провайдера, а не человек: IP-дверь для него была бы ложной блокировкой.
  // IPv6 уже сведён к /64, поэтому один клиент не получает новое окно на каждый адрес подсети.
  if (!network.cgnat) {
    const byIp = await consume("ip:" + action + ":" + network.key, IP_LIMITS[action], action);
    if (!byIp.allowed) return byIp;
  }

  const normalized = subject?.trim().toLowerCase();
  if (normalized) {
    const bySubject = await consume("subject:" + action + ":" + normalized, SUBJECT_LIMITS[action], action);
    if (!bySubject.allowed) return bySubject;
  }
  return { allowed: true };
}

async function consume(key: string, limit: number, action: AuthAction): Promise<RateLimitResult> {
  try {
    return await consumeRateLimit(key, limit, WINDOW_MS);
  } catch (error) {
    const failClosed = FAIL_CLOSED_ACTIONS.has(action);
    console.warn(
      "[auth] счётчик попыток недоступен, " +
        (failClosed ? "fail-closed для " + action : "проверка лимита пропущена") +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
    return failClosed
      ? { allowed: false, retryAfter: Math.ceil(WINDOW_MS / 1000) }
      : { allowed: true };
  }
}

/** Сброс окон: тесты начинают с чистых счётчиков, администратор — при разборе блокировки. */
export async function clearAuthRateLimits(): Promise<void> {
  await clearRateLimits();
}
