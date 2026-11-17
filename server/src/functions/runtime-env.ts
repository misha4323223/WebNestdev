import { loadStoredSecretValues } from "../secrets/secret-store.js";

/**
 * Окружение проекта для исполнителя функций.
 *
 * Секреты лежат в зашифрованном хранилище и монтируются только на invocation: в артефакт
 * релиза они не попадают. Порядок как у приложения: `.env` → `.env.local` → `.env.production`.
 */
export async function projectFunctionEnv(projectId: string): Promise<Record<string, string>> {
  const files = await loadStoredSecretValues(projectId).catch(() => null);
  if (!files) return {};
  return Object.assign({}, files[".env"] ?? {}, files[".env.local"] ?? {}, files[".env.production"] ?? {});
}
