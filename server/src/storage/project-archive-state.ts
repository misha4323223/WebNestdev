import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Локальная отметка «рабочая папка проекта лежит в бакете».
 *
 * Сам архив — в объектном хранилище, но серверу нужно дёшево понимать, что проекта нет на диске:
 * файл на несколько сотен байт рядом с остальными данными. Отметка живёт на том же хосте, что и
 * песочницы, — ровно как сами папки проектов, поэтому отдельная таблица в базе ничего бы не
 * добавила, а согласованность между репликами не гарантирует и она.
 */
export type ProjectArchiveRecord = {
  projectId: string;
  userId: string;
  key: string;
  bytes: number;
  archivedAt: string;
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

export async function readArchiveRecord(projectId: string): Promise<ProjectArchiveRecord | null> {
  try {
    return JSON.parse(await readFile(archiveRecordFile(projectId), "utf8")) as ProjectArchiveRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Запись атомарная: половина JSON после падения процесса означала бы «архив есть», а ключа нет. */
export async function writeArchiveRecord(record: ProjectArchiveRecord) {
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

/**
 * Все отметки холодного яруса. Админке нужен не только счётчик, но и проект с датой и размером:
 * по ним видно, какие проекты уже лежат в бакете и когда они туда уехали.
 */
export async function listArchiveRecords(): Promise<ProjectArchiveRecord[]> {
  const names = await readdir(archiveStateDir()).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  const records: ProjectArchiveRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await readFile(path.join(archiveStateDir(), name), "utf8")) as ProjectArchiveRecord);
    } catch {
      // Повреждённая отметка — не повод ронять весь снимок: проект просто не попадёт в список.
    }
  }
  return records;
}

export async function clearArchiveRecord(projectId: string) {
  await rm(archiveRecordFile(projectId), { force: true });
}
