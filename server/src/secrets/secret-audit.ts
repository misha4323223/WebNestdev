import { createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";

/**
 * Аудит операций с секретами.
 *
 * В журнал попадают только имена переменных, файл, действие, проект, пользователь и хеш IP.
 * Значение секрета не передаётся сюда ни одним вызовом — это делает журнал безопасным для
 * хранения рядом с остальными данными и для чтения в панели.
 *
 * Запись best-effort: сбой журнала не должен терять уже сохранённый секрет, но и молчать о нём
 * нельзя — ошибка уходит в лог сервера, а вызывающий получает `ok: false`.
 */

export type SecretAuditAction = "write" | "import" | "delete" | "request" | "cancel";

export type SecretAuditEntry = {
  id: string;
  projectId: string;
  userId: string;
  action: SecretAuditAction;
  names: string[];
  file: string;
  ipHash: string;
  createdAt: string;
};

export type SecretAuditInput = Omit<SecretAuditEntry, "id" | "createdAt">;

const FILE_NAME = "secret-audit.jsonl";
const MAX_NAMES = 200;
const MAX_NAME_CHARS = 128;
const MAX_FILE_CHARS = 300;

function dataDirectory() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

export function secretAuditFile() {
  return path.join(dataDirectory(), FILE_NAME);
}

/**
 * IP не хранится открытым: по нему нельзя восстановить адрес без соли, а сравнить два события
 * одного источника можно. Соль — отдельная переменная, иначе ключ шифрования секретов отвечал
 * бы ещё и за приватность журнала.
 */
export function hashAuditIp(ip?: string) {
  if (!ip) return "";
  const salt =
    process.env.WEBNESTDEV_AUDIT_SALT ??
    process.env.WEBNESTDEV_ENCRYPTION_KEY ??
    "webnestdev-audit";
  return createHmac("sha256", salt).update(ip).digest("hex").slice(0, 32);
}

function clean(input: SecretAuditInput): SecretAuditInput {
  return {
    projectId: input.projectId.slice(0, 200),
    userId: input.userId.slice(0, 200),
    action: input.action,
    names: [...new Set(input.names)]
      .map((name) => name.trim().slice(0, MAX_NAME_CHARS))
      .filter(Boolean)
      .slice(0, MAX_NAMES),
    file: input.file.slice(0, MAX_FILE_CHARS),
    ipHash: input.ipHash.slice(0, 64),
  };
}

async function appendJson(entry: SecretAuditEntry) {
  const file = secretAuditFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
}

export async function recordSecretAudit(input: SecretAuditInput): Promise<{ ok: boolean; error?: string }> {
  const cleaned = clean(input);
  if (!cleaned.names.length) return { ok: true };
  const entry: SecretAuditEntry = { ...cleaned, id: randomUUID(), createdAt: new Date().toISOString() };
  try {
    if (isYdbEnabled()) {
      await ydbQuery()`
        INSERT INTO ${ydbQuery().identifier(getTable("secret_audit"))}
          (id, project_id, user_id, action, names_json, file, ip_hash, created_at)
        VALUES (${entry.id}, ${entry.projectId}, ${entry.userId}, ${entry.action}, ${JSON.stringify(entry.names)}, ${entry.file}, ${entry.ipHash}, ${entry.createdAt})
      `;
    } else {
      await appendJson(entry);
    }
    return { ok: true };
  } catch (error) {
    console.error("[secrets] не удалось записать аудит операции с секретами", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Последние события проекта, новые сверху. Значений секретов в строках нет по построению. */
export async function listSecretAudit(projectId: string, limit = 50): Promise<SecretAuditEntry[]> {
  const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{
      id: string;
      project_id: string;
      user_id: string;
      action: string;
      names_json: string;
      file: string;
      ip_hash: string;
      created_at: string;
    }>>`
      SELECT id, project_id, user_id, action, names_json, file, ip_hash, created_at
      FROM ${ydbQuery().identifier(getTable("secret_audit"))}
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC
      LIMIT ${bounded}
    `;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      action: row.action as SecretAuditAction,
      names: JSON.parse(row.names_json || "[]") as string[],
      file: row.file,
      ipHash: row.ip_hash,
      createdAt: row.created_at,
    }));
  }
  let raw: string;
  try {
    raw = await readFile(secretAuditFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: SecretAuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as SecretAuditEntry;
      if (entry.projectId === projectId) entries.push(entry);
    } catch {
      // Повреждённая строка журнала не должна скрывать остальные события.
    }
  }
  return entries.slice(-bounded).reverse();
}
