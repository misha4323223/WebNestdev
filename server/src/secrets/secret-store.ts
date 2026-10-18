import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret } from "../storage/secret-crypto.js";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";

/**
 * Каноническое хранилище секретов проекта.
 *
 * Раньше `.env.local` был и хранилищем, и файлом, который читает приложение: значение лежало
 * в рабочей области, то есть в архиве проекта, в резервной копии и в любом обходе файлов.
 * Теперь значения лежат здесь одним зашифрованным payload-ом, а `.env.local` существует только
 * как временный read-only mount у контейнера предпросмотра. Агент, файловый API, git и архив
 * проекта его не видят.
 *
 * Payload шифруется целиком, поэтому имена переменных тоже не читаются без ключа. Формат
 * значения — обычный JSON-объект `{ NAME: "value" }`; шифрование — AES-256-GCM из
 * storage/secret-crypto.ts, то есть тот же ключ и та же ротация, что у остальных секретов.
 */

/** Файл окружения → переменная → значение. Файлов несколько: `.env`, `.env.local`, `.env.production`. */
export type SecretFiles = Record<string, Record<string, string>>;

type StoredPayload = {
  version: 1;
  payload: string;
};

function dataDirectory() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

function safeProjectId(projectId: string) {
  return projectId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}

/** Файл одного проекта. Экспортируется для тестов и диагностики, значение не раскрывает. */
export function secretStoreFile(projectId: string) {
  return path.join(dataDirectory(), "project-secrets", safeProjectId(projectId) + ".json");
}

function parseValues(raw: string): SecretFiles {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Повреждённое хранилище секретов проекта");
  }
  const result: SecretFiles = {};
  for (const [file, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Повреждённое хранилище секретов проекта");
    }
    const variables: Record<string, string> = {};
    for (const [name, secret] of Object.entries(value as Record<string, unknown>)) {
      if (typeof secret !== "string") throw new Error("Повреждённое хранилище секретов проекта");
      variables[name] = secret;
    }
    result[file] = variables;
  }
  return result;
}

async function loadJson(projectId: string): Promise<SecretFiles | null> {
  let raw: string;
  try {
    raw = await readFile(secretStoreFile(projectId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const stored = JSON.parse(raw) as StoredPayload;
  if (stored.version !== 1 || typeof stored.payload !== "string") {
    throw new Error("Повреждённое хранилище секретов проекта");
  }
  return parseValues(decryptSecret(stored.payload));
}

async function saveJson(projectId: string, values: SecretFiles) {
  const file = secretStoreFile(projectId);
  if (!Object.keys(values).length) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const stored: StoredPayload = { version: 1, payload: encryptSecret(JSON.stringify(values)) };
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch { /* temp мог не создаться */ }
    throw error;
  }
}

async function loadPostgres(projectId: string): Promise<SecretFiles | null> {
  const [rows] = await ydbQuery()<Array<{ payload: string }>>`
    SELECT payload
    FROM ${ydbQuery().identifier(getTable("project_secrets"))}
    WHERE project_id = ${projectId}
    LIMIT 1
  `;
  const payload = rows?.[0]?.payload;
  if (!payload) return null;
  return parseValues(decryptSecret(payload));
}

async function savePostgres(projectId: string, values: SecretFiles) {
  if (!Object.keys(values).length) {
    await ydbQuery()`
      DELETE FROM ${ydbQuery().identifier(getTable("project_secrets"))}
      WHERE project_id = ${projectId}
    `;
    return;
  }
  const payload = encryptSecret(JSON.stringify(values));
  const updatedAt = new Date().toISOString();
  await ydbQuery()`
    INSERT INTO ${ydbQuery().identifier(getTable("project_secrets"))}
      (project_id, payload, updated_at)
    VALUES (${projectId}, ${payload}, ${updatedAt})
    ON CONFLICT (project_id) DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = EXCLUDED.updated_at
  `;
}

/** `null` — проекта ещё нет в хранилище; пустой объект — секретов нет. */
export async function loadStoredSecretValues(projectId: string): Promise<SecretFiles | null> {
  return isYdbEnabled() ? loadPostgres(projectId) : loadJson(projectId);
}

/** Пустой объект удаляет запись: отсутствие секретов не должно оставлять пустой шифротекст. */
export async function saveStoredSecretValues(projectId: string, values: SecretFiles) {
  if (isYdbEnabled()) await savePostgres(projectId, values);
  else await saveJson(projectId, values);
}
