import { loadStoredSecretValues } from "../secrets/secret-store.js";
import { productionEnvValues } from "../secrets/env-precedence.js";

/**
 * Окружение проекта для опубликованных функций и фоновых заданий.
 *
 * Секреты лежат в зашифрованном хранилище и передаются только на invocation: в артефакт
 * релиза они не попадают. Порядок и состав файлов — общий с публикацией
 * (`env-precedence.ts`), поэтому значение, которое сборка видит как production, функция
 * получает тем же. Секреты, добавленные после публикации, подхватываются со следующего
 * вызова без перевыпуска релиза.
 */
export async function projectFunctionEnv(projectId: string): Promise<Record<string, string>> {
  const files = await loadStoredSecretValues(projectId).catch(() => null);
  return productionEnvValues(files);
}
