import { projectSecretValuesForScan, redactSecretText } from "../hosting/security.js";
import { loadStoredSecretValues } from "../secrets/secret-store.js";

/**
 * Вывод предпросмотра — это чужой код проекта, но показать его без проверки нельзя: приложение
 * может напечатать выданные ему переменные окружения. Перед возвратом в панель, агенту или
 * внутреннюю дверь убираем точные значения из зашифрованного хранилища секретов.
 *
 * Это не «антивирус»: значение, закодированное приложением (base64, URL-encoding, по частям),
 * не совпадёт с исходной строкой. Такой случай остаётся остаточной границей и описан в
 * docs/SECURITY.md; здесь закрыт самый частый путь — прямой `console.log(process.env.SECRET)`.
 */
export async function redactPreviewLog(projectId: string, text: string): Promise<string> {
  if (!text) return text;
  let files: Awaited<ReturnType<typeof loadStoredSecretValues>>;
  try {
    files = await loadStoredSecretValues(projectId);
  } catch {
    // Fail closed: без чтения секретов нельзя гарантировать, что в логе нет значения.
    throw new Error("Не удалось проверить секреты проекта перед показом логов; вывод скрыт, чтобы не раскрыть значения");
  }
  const values = await projectSecretValuesForScan(files);
  return redactSecretText(text, values);
}

/**
 * Ошибка запуска может содержать хвост вывода контейнера или сборки. Сохраняем тип ошибки
 * (по нему маршрут отличает запрет тарифа), но правим сообщение; при сбое чтения секретов
 * показываем безопасную причину вместо исходного текста.
 */
export async function redactPreviewError(projectId: string, error: unknown): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const safe = await redactPreviewLog(projectId, message);
    if (error instanceof Error) {
      if (safe !== message) error.message = safe;
      return error;
    }
    return new Error(safe);
  } catch {
    const safe = "Предпросмотр не запустился; подробности скрыты, чтобы не раскрыть секреты проекта.";
    if (error instanceof Error) {
      error.message = safe;
      return error;
    }
    return new Error(safe);
  }
}
