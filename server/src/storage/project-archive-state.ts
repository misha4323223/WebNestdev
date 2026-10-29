import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "./pg.js";

/**
 * Отметка «рабочая папка проекта лежит в бакете».
 *
 * В PostgreSQL это строка в `project_archives`: её видит любая реплика и она переживает потерю
 * тома, на котором раньше лежал JSON-файл. В JSON-режиме (локальная разработка и тесты) остаётся
 * прежний файл в `WEBNESTDEV_DATA_DIR/project-archives`: отдельная база там не нужна.
 *
 * Старые файлы не удаляются при переносе: они служат снимком для отката, а база после включения
 * PostgreSQL — источник истины. Импорт идемпотентен: `INSERT ... ON CONFLICT DO NOTHING`, поэтому
 * повторный запуск ничего не дублирует. Файл отметки удаляется вместе с записью при
 * восстановлении проекта, иначе следующий старт вернул бы уже снятую отметку.
 */
export type ProjectArchiveRecord = {
  projectId: string;
  userId: string;
  key: string;
  bytes: number;
  archivedAt: string;
  /** Узел, который упаковал проект; пусто у старых отметок и в JSON-режиме. */
  node?: string;
};

type ArchiveRow = {
  project_id: string;
  user_id: string;
  key: string;
  bytes: string | number;
  archived_at: string;
  node: string | null;
};

/** Идентификатор проекта приходит из URL, поэтому в имени файла остаются только безопасные символы. */
function safeId(projectId: string) {
  return projectId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function archiveStateDir() {
  return path.join(process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev"), "project-archives");
}

export function archiveRecordFile(projectId: string) {
  return path.join(archiveStateDir(), safeId(projectId) + ".json");
}

function rowToRecord(row: ArchiveRow): ProjectArchiveRecord {
  return {
    projectId: row.project_id,
    userId: row.user_id,
    key: row.key,
    // node-postgres отдаёт BIGINT строкой: без Number() размер пришёл бы в API строкой.
    bytes: Number(row.bytes),
    archivedAt: row.archived_at,
    ...(row.node ? { node: row.node } : {}),
  };
}

async function readFileRecord(projectId: string): Promise<ProjectArchiveRecord | null> {
  try {
    return parseArchiveRecord(JSON.parse(await readFile(archiveRecordFile(projectId), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Запись атомарная: половина JSON после падения процесса означала бы «архив есть», а ключа нет. */
async function writeFileRecord(record: ProjectArchiveRecord) {
  const file = archiveRecordFile(record.projectId);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readFileRecords(): Promise<ProjectArchiveRecord[]> {
  const names = await readdir(archiveStateDir()).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const records: ProjectArchiveRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = parseArchiveRecord(JSON.parse(await readFile(path.join(archiveStateDir(), name), "utf8")));
      if (record) records.push(record);
    } catch {
      // Повреждённая отметка — не повод ронять весь снимок: проект просто не попадёт в список.
    }
  }
  return records;
}

export async function readArchiveRecord(projectId: string): Promise<ProjectArchiveRecord | null> {
  if (!isYdbEnabled()) return readFileRecord(projectId);
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("project_archives"));
  const [rows] = await ydbQuery()<ArchiveRow[]>`
    SELECT project_id, user_id, key, bytes, archived_at, node
      FROM ${table}
     WHERE project_id = ${projectId}`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function writeArchiveRecord(record: ProjectArchiveRecord) {
  if (!isYdbEnabled()) return writeFileRecord(record);
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("project_archives"));
  await ydbQuery()`
    INSERT INTO ${table} (project_id, user_id, key, bytes, archived_at, node)
    VALUES (${record.projectId}, ${record.userId}, ${record.key}, ${record.bytes}, ${record.archivedAt}, ${record.node ?? ""})
    ON CONFLICT (project_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      key = EXCLUDED.key,
      bytes = EXCLUDED.bytes,
      archived_at = EXCLUDED.archived_at,
      node = EXCLUDED.node`;
}

/**
 * Вставка только если записи ещё нет. Возвращает `true`, если строка действительно появилась:
 * импорт по этому признаку отличает перенесённую отметку от уже известной.
 */
async function insertArchiveRecordIfMissing(record: ProjectArchiveRecord): Promise<boolean> {
  const table = ydbQuery().identifier(getTable("project_archives"));
  const [rows] = await ydbQuery()<Array<{ project_id: string }>>`
    INSERT INTO ${table} (project_id, user_id, key, bytes, archived_at, node)
    VALUES (${record.projectId}, ${record.userId}, ${record.key}, ${record.bytes}, ${record.archivedAt}, ${record.node ?? ""})
    ON CONFLICT (project_id) DO NOTHING
    RETURNING project_id`;
  return rows.length > 0;
}

/**
 * Все отметки холодного яруса. Админке нужен не только счётчик, но и проект с датой и размером:
 * по ним видно, какие проекты уже лежат в бакете и когда они туда уехали.
 */
export async function listArchiveRecords(): Promise<ProjectArchiveRecord[]> {
  if (!isYdbEnabled()) return readFileRecords();
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("project_archives"));
  const [rows] = await ydbQuery()<ArchiveRow[]>`
    SELECT project_id, user_id, key, bytes, archived_at, node
      FROM ${table}
     ORDER BY archived_at DESC`;
  return rows.map(rowToRecord);
}

export async function clearArchiveRecord(projectId: string) {
  if (isYdbEnabled()) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("project_archives"));
    await ydbQuery()`DELETE FROM ${table} WHERE project_id = ${projectId}`;
  }
  // В PostgreSQL-режиме файл — лишь снимок для отката. Если его не убрать, следующий старт
  // импортирует уже снятую отметку и проект снова станет «архивным».
  await rm(archiveRecordFile(projectId), { force: true });
}

/** Для `/api/health` и лога: сколько проектов сейчас лежит в бакете. */
export async function archivedProjectCount(): Promise<number> {
  if (!isYdbEnabled()) {
    const names = await readdir(archiveStateDir()).catch(() => [] as string[]);
    return names.filter(name => name.endsWith(".json")).length;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("project_archives"));
  const [rows] = await ydbQuery()<Array<{ count: string | number }>>`
    SELECT COUNT(*)::int AS count FROM ${table}`;
  return Number(rows[0]?.count ?? 0);
}

/** Разбор отметки из JSON: старые файлы могли быть обрезаны или отредактированы руками. */
export function parseArchiveRecord(raw: unknown): ProjectArchiveRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const key = typeof value.key === "string" ? value.key.trim() : "";
  const bytes = typeof value.bytes === "number" ? value.bytes : Number(value.bytes);
  const archivedAt = typeof value.archivedAt === "string" ? value.archivedAt.trim() : "";
  if (!projectId || !userId || !key) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (!Number.isFinite(Date.parse(archivedAt))) return null;
  const node = typeof value.node === "string" && value.node.trim() ? value.node.trim() : undefined;
  return { projectId, userId, key, bytes: Math.trunc(bytes), archivedAt, ...(node ? { node } : {}) };
}

export type ArchiveImportResult = { imported: number; skipped: number; failed: number };

/**
 * Перенос старых JSON-отметок в базу.
 *
 * Файлы намеренно остаются на месте: это снимок для отката на прежнюю версию, а источником истины
 * после включения PostgreSQL становится таблица. Повторный запуск безопасен — вставка идёт через
 * `ON CONFLICT DO NOTHING`, поэтому уже известные проекты попадают в `skipped`.
 *
 * `insert` вынесен параметром, чтобы тест мог проверить импорт без живой базы.
 */
export async function importArchiveRecords(
  dir: string,
  insert: (record: ProjectArchiveRecord) => Promise<boolean>,
  options: { log?: (message: string) => void } = {},
): Promise<ArchiveImportResult> {
  const result: ArchiveImportResult = { imported: 0, skipped: 0, failed: 0 };
  const names = await readdir(dir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let record: ProjectArchiveRecord | null = null;
    try {
      record = parseArchiveRecord(JSON.parse(await readFile(file, "utf8")));
    } catch {
      record = null;
    }
    if (!record) {
      result.failed++;
      options.log?.("[storage] отметка холодного яруса " + name + " не разобрана — пропускаю");
      continue;
    }
    try {
      if (await insert(record)) result.imported++;
      else result.skipped++;
    } catch (error) {
      result.failed++;
      options.log?.(
        "[storage] отметка холодного яруса " + name + " не перенесена: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return result;
}

/** Импорт при старте: только в PostgreSQL-режиме, после готовности схемы. */
export async function importArchiveRecordsFromDisk(): Promise<ArchiveImportResult> {
  if (!isYdbEnabled()) return { imported: 0, skipped: 0, failed: 0 };
  await initializeStorage();
  const result = await importArchiveRecords(archiveStateDir(), insertArchiveRecordIfMissing, {
    log: message => console.warn(message),
  });
  // Одна строка на старте: по ней в логе выкатки видно, что таблица читается и сколько отметок
  // уже в базе. Без неё «переезд прошёл» и «переезд не запускался» выглядят одинаково.
  const total = await archivedProjectCount();
  console.log(
    "[storage] отметки холодного яруса: в базе " + total + ", перенесено " + result.imported +
      ", уже было " + result.skipped + ", ошибок " + result.failed,
  );
  return result;
}
