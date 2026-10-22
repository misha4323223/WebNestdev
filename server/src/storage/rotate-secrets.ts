import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecretWith, encryptSecretWith } from "./secret-crypto.js";

/**
 * Перешифровка файловых хранилищ со старого ключа на новый. Список полей — это контракт
 * с хранилищами: если появится новое зашифрованное поле и его здесь не будет, после смены
 * ключа оно перестанет читаться. Тест проверяет каждое поле из списка.
 */
export const JSON_TARGETS = [
  { folder: "providers", fields: ["token"] },
  { folder: "github", fields: ["accessToken"] },
  { folder: "gitlab", fields: ["accessToken"] },
  // Хостинги кода на токене: GitVerse и SourceCraft. У GitVerse бывает refreshToken.
  { folder: "repos/gitverse", fields: ["accessToken", "refreshToken"] },
  { folder: "repos/sourcecraft", fields: ["accessToken"] },
  { folder: "yandex", fields: ["secret"] },
  { folder: "database", fields: ["password", "url"] },
  // Подключения из «Интеграций»: облака, регистраторы домена и сервисы с ключом лежат в одном
  // файле пользователя картой `провайдер → { secret, account, … }` — отсюда `keyed`.
  { folder: "cloud", fields: ["secret"], keyed: true },
  { folder: "domains", fields: ["secret"], keyed: true },
  { folder: "services", fields: ["secret"], keyed: true },
  // Один payload на проект: внутри JSON-объект `файл → переменная → значение`.
  { folder: "project-secrets", fields: ["payload"] },
] as const;

export type JsonRotation = { files: string[]; fields: number };

async function readdirSafe(dir: string) {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Записи карты `ключ → объект`: значения-объекты перешифровываются на месте. */
function nestedRecords(value: Record<string, unknown>): Array<Record<string, unknown>> {
  return Object.values(value).filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

/** Плейнтекст (старые установки) тоже проходит через ротацию и уходит на диск шифротекстом. */
function rewrap(value: unknown, oldKey: string, newKey: string) {
  if (typeof value !== "string" || !value) return null;
  return encryptSecretWith(decryptSecretWith(value, oldKey), newKey);
}

/**
 * Сначала читается и расшифровывается всё, и только потом что-то пишется: ошибка старого
 * ключа или повреждённый файл оставляют хранилище нетронутым. Запись каждого файла атомарная.
 */
export async function rotateJsonStore(
  root: string,
  oldKey: string,
  newKey: string,
  options: { platformFile?: string } = {},
): Promise<JsonRotation> {
  const changes: Array<{ file: string; value: Record<string, unknown> }> = [];
  const files: string[] = [];
  let fields = 0;

  for (const target of JSON_TARGETS) {
    const dir = path.join(root, target.folder);
    for (const name of await readdirSafe(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      let touched = false;
      const records = "keyed" in target && target.keyed ? nestedRecords(value) : [value];
      for (const record of records) {
        for (const field of target.fields) {
          const next = rewrap(record[field], oldKey, newKey);
          if (next === null) continue;
          record[field] = next;
          touched = true;
          fields++;
        }
      }
      if (touched) {
        changes.push({ file, value });
        files.push(target.folder + "/" + name);
      }
    }
  }

  // Ключи платформы лежат отдельно от подключений и читаются до инициализации базы.
  const platformFile = options.platformFile ?? path.join(root, "platform", "env.json");
  let platform: { values?: Record<string, { value?: string }> } | null = null;
  try {
    platform = JSON.parse(await readFile(platformFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (platform) {
    let touched = false;
    for (const entry of Object.values(platform.values ?? {})) {
      const next = rewrap(entry?.value, oldKey, newKey);
      if (next === null) continue;
      entry.value = next;
      touched = true;
      fields++;
    }
    if (touched) {
      changes.push({ file: platformFile, value: platform as Record<string, unknown> });
      files.push("platform/env.json");
    }
  }

  for (const change of changes) {
    const temp = change.file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, JSON.stringify(change.value, null, 2), { mode: 0o600 });
      await rename(temp, change.file);
    } catch (error) {
      try {
        await unlink(temp);
      } catch {}
      throw error;
    }
  }
  return { files, fields };
}
