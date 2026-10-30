import { randomBytes } from "node:crypto";
import { getUserProfile, saveUserProfile } from "../account/profile-store.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { createUser, findUserByEmail, type User } from "./auth-store.js";

/**
 * Временный публичный доступ для проверки платёжного сервиса.
 *
 * Включается флагом `WEBNESTDEV_PUBLIC_DEMO=1` в панели «Ключи сервера» и работает без
 * выкатки: `/api/auth/me` сам выдаёт сессию отдельному демо-аккаунту, если у браузера её ещё
 * нет. Аккаунт не пересекается с реальными пользователями; когда флаг выключен, его сессии
 * перестают приниматься, и снова показывается обычный вход.
 */
export const PUBLIC_DEMO_EMAIL = "review@webnestdev.local";
export const PUBLIC_DEMO_NAME = "Гость NestDev";

export function publicDemoEnabled() {
  const value = getPlatformEnv("WEBNESTDEV_PUBLIC_DEMO")?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "да";
}

export function isPublicDemoAccount(user: { email: string } | null | undefined) {
  return Boolean(user && user.email.trim().toLowerCase() === PUBLIC_DEMO_EMAIL);
}

/**
 * Демо-аккаунт создаётся при первом заходе, а не при старте: флаг можно включить в панели
 * без перезапуска. Пароль случайный и никуда не сохраняется — войти в этот аккаунт можно
 * только через публичный режим.
 */
export async function ensurePublicDemoUser(): Promise<User> {
  let user = await findUserByEmail(PUBLIC_DEMO_EMAIL);
  if (!user) {
    try {
      user = await createUser(PUBLIC_DEMO_EMAIL, randomBytes(32).toString("hex"));
    } catch (error) {
      // Два первых посетителя могли создать аккаунт одновременно: второй получает уже
      // существующую запись, а не ошибку.
      user = await findUserByEmail(PUBLIC_DEMO_EMAIL);
      if (!user) throw error;
    }
  }
  // Профиль заполнен, чтобы знакомство не перекрывало сайт. Имя видно в колонке аккаунта,
  // почта пустая: служебный адрес …@webnestdev.local в интерфейсе не показывается.
  if (!(await getUserProfile(user.id))) {
    await saveUserProfile(user.id, {
      name: PUBLIC_DEMO_NAME,
      email: "",
      newsletter: false,
      productUpdates: false,
      source: "moderation",
    });
  }
  return user;
}
