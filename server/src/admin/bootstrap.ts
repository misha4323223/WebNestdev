import { ADMIN_EMAIL_TAKEN, createAdmin, findAdminByEmail } from "./admin-store.js";

/**
 * Первый администратор из окружения.
 *
 * Обычный путь — CLI на сервере (`npm run admin:create`). Но у ВМ может не быть доступного
 * терминала, а пароль нельзя придумать в панели: аккаунта ещё нет. Поэтому первый админ может
 * быть объявлен двумя переменными развёртывания, которые выкатка и так умеет доставлять в `.env`
 * (docs/ADMIN_API.md): почта и пароль.
 *
 * Правила намеренно узкие:
 * - пароль короче 12 символов не принимается: это вход на всю платформу;
 * - существующая запись не меняется — повторная выкатка не сбрасывает ни пароль, ни TOTP;
 * - значение пишется в лог только фактом («создан»), сам пароль не печатается.
 *
 * Фактор всё равно обязателен: созданный так администратор при первом входе проходит подключение
 * TOTP и получает коды восстановления. Переменные после первого входа стоит убрать из секретов
 * (или заменить пароль случайным значением): пока админ существует, они не действуют, но если
 * запись когда-нибудь удалят, старое значение снова станет паролем.
 */
export const BOOTSTRAP_EMAIL_ENV = "ADMIN_BOOTSTRAP_EMAIL";
export const BOOTSTRAP_PASSWORD_ENV = "ADMIN_BOOTSTRAP_PASSWORD";
/** Минимум для входа администратора: пароль в 8 символов здесь слишком слаб. */
export const BOOTSTRAP_MIN_PASSWORD = 12;

export type BootstrapResult =
  | { status: "created"; email: string }
  | { status: "exists"; email: string }
  | { status: "skipped"; reason: string };

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function ensureBootstrapAdmin(): Promise<BootstrapResult> {
  const email = (process.env[BOOTSTRAP_EMAIL_ENV] ?? "").trim().toLowerCase();
  const password = process.env[BOOTSTRAP_PASSWORD_ENV] ?? "";

  if (!email) return { status: "skipped", reason: BOOTSTRAP_EMAIL_ENV + " не задан" };
  if (!looksLikeEmail(email)) return { status: "skipped", reason: "некорректный email в " + BOOTSTRAP_EMAIL_ENV };
  if (!password) return { status: "skipped", reason: BOOTSTRAP_PASSWORD_ENV + " не задан" };
  if (password.length < BOOTSTRAP_MIN_PASSWORD) {
    return { status: "skipped", reason: BOOTSTRAP_PASSWORD_ENV + " короче " + BOOTSTRAP_MIN_PASSWORD + " символов" };
  }
  if (await findAdminByEmail(email)) return { status: "exists", email };

  try {
    await createAdmin(email, password);
    return { status: "created", email };
  } catch (error) {
    // Две реплики стартовали одновременно: проигравший видит уже созданную запись, и это не ошибка.
    if (error instanceof Error && error.message === ADMIN_EMAIL_TAKEN) return { status: "exists", email };
    throw error;
  }
}
