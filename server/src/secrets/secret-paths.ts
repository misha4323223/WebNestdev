import path from "node:path";
import { isSecretEnvFile } from "../sandbox/permissions.js";

/**
 * Секретный файл — это `.env` и его варианты (`.env.local`, `.env.production.local`), но не
 * шаблоны `.env.example`, `.env.sample` и `.env.template`: шаблоны не содержат значений и нужны
 * агенту, чтобы понять, какие переменные проект ожидает.
 *
 * Проверка идёт по имени, а не по полному пути: файл может лежать в подкаталоге (`apps/web/.env`),
 * и это точно такой же секрет. Путь нормализуется, чтобы `./.env.local` и `.env.local/` не
 * превращались в исключение.
 */
export function isSecretProjectPath(relativePath: string) {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  return isSecretEnvFile(path.posix.basename(normalized));
}

/** Сообщение одно на все точки отказа: что произошло и чем заменить действие. */
export function secretEnvRefusal(relativePath: string, action = "читать") {
  return (
    "Файл " +
    relativePath +
    " содержит секреты проекта, поэтому его нельзя " +
    action +
    " агенту. Значения попадают только в приложение при запуске. " +
    "Чтобы изменить секрет, используйте панель «Секреты» или инструмент secrets.request; " +
    "чтобы описать переменные без значений — файл .env.example."
  );
}

/** Бросает отказ, если путь указывает на секретный файл. */
export function assertNotSecretProjectPath(relativePath: string, action = "читать") {
  if (isSecretProjectPath(relativePath)) throw new Error(secretEnvRefusal(relativePath, action));
}
