import type { SecretFiles } from "./secret-store.js";

/**
 * Какие env-файлы читает опубликованный проект.
 *
 * В разработке и на предпросмотре читаются все файлы проекта, включая `.env.development`:
 * так работает `npm run dev`. Публикация — это production, и там действует обычное для
 * dotenv/Next.js правило старшинства: поздний файл перекрывает ранний, локальный вариант
 * сильнее обычного. `.env.development` и прочие режимы в релиз не попадают, иначе
 * тестовые значения молча оказались бы на боевом сайте.
 *
 * Порядок отсюда же используют сборка статики (только публичные имена) и окружение
 * serverless-функций (все имена): один источник правды, без расхождений между сборкой и
 * запуском.
 */
export const PRODUCTION_ENV_FILES = [
  ".env",
  ".env.production",
  ".env.local",
  ".env.production.local",
] as const;

/** Значения переменных для production: файлы в порядке старшинства, имя → значение. */
export function productionEnvValues(files: SecretFiles | null): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of PRODUCTION_ENV_FILES) {
    const variables = files?.[file];
    if (!variables) continue;
    for (const [name, value] of Object.entries(variables)) merged[name] = value;
  }
  return merged;
}
