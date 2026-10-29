import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ObjectStore } from "./object-store.js";

/**
 * Резервная копия PostgreSQL в объектное хранилище платформы.
 *
 * Почему это отдельный модуль, а не часть холодного яруса проектов: у бэкапа базы другой
 * жизненный цикл и другая цена ошибки. Архив проекта можно пересобрать, потерянную базу — нет.
 * Здесь только работа с объектами; сам `pg_dump` запускает оболочка на ВМ
 * (`deploy/scripts/pg-backup.sh`), потому что дамп должен снимать контейнер `postgres:17`, а не
 * сервер: клиент `pg_dump` старше сервера отказывается работать, и версия клиента в образе
 * сервера не должна решать судьбу бэкапа.
 *
 * Раскладка:
 *   <prefix>/backups/postgres/<база>/<ГГГГ>/<ММ>/<ДД>/<база>-<время>.dump
 *   <prefix>/backups/postgres/<база>/latest.json
 *
 * `latest.json` — не украшение: по нему проверка свежести и восстановление находят последний
 * дамп, не перечисляя весь бакет. Манифест пишется только после того, как дамп загружен и его
 * размер подтверждён `HEAD`: манифест не должен указывать на несуществующий объект.
 */

export type BackupManifest = {
  version: 1;
  database: string;
  key: string;
  bytes: number;
  sha256: string;
  createdAt: string;
};

export type PutBackupOptions = {
  store: ObjectStore;
  database: string;
  input: Readable;
  /** Момент снимка; в тестах подставляется, чтобы ключ был предсказуемым. */
  now?: Date;
  /** Куда писать временный дамп; по умолчанию системный tmp. */
  tempRoot?: string;
  /** Потолок размера дампа: защита от бесконечного потока и заполнения диска. */
  maxBytes?: number;
};

export type CheckBackupOptions = {
  store: ObjectStore;
  database: string;
  maxAgeHours?: number;
  now?: Date;
  tempRoot?: string;
};

export type ReadBackupOptions = {
  store: ObjectStore;
  key: string;
  sha256: string;
  output: Writable;
  tempRoot?: string;
};

const DEFAULT_PREFIX = "webnestdev";
const DEFAULT_MAX_AGE_HOURS = 30;
/** Восемь гигабайт — не рабочий размер, а предохранитель: больше одного дампа не ждём. */
const MAX_DUMP_BYTES = 8 * 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
/** Имя базы PostgreSQL: буквы, цифры, `_`, `$`, `-`; кавычки и слэши сюда не попадают. */
const DATABASE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;
/** Имя файла в ключе: без слэшей и двоеточий, чтобы ключ оставался предсказуемым. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

function prefixOf(prefix: string) {
  const clean = prefix.replace(/^\/+|\/+$/g, "");
  return clean || DEFAULT_PREFIX;
}

/** Сегмент базы в ключе: нижний регистр, всё неподходящее — `_`. */
export function backupDatabaseSegment(database: string) {
  if (!DATABASE.test(database)) {
    throw new Error("Некорректное имя базы для резервной копии: " + database);
  }
  const segment = database.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  if (!segment) throw new Error("Из имени базы не получился сегмент ключа: " + database);
  return segment;
}

/** `20261029T023000Z` — сортируемая метка без двоеточий (они допустимы, но лишние). */
export function backupStamp(now: Date) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function backupObjectKey(prefix: string, database: string, now = new Date(), name?: string) {
  const segment = backupDatabaseSegment(database);
  const file = name ?? segment + "-" + backupStamp(now) + ".dump";
  if (!FILE_NAME.test(file)) throw new Error("Некорректное имя файла резервной копии: " + file);
  const day = now.toISOString().slice(0, 10).split("-").join("/");
  return [prefixOf(prefix), "backups", "postgres", segment, day, file].join("/");
}

export function manifestObjectKey(prefix: string, database: string) {
  return [prefixOf(prefix), "backups", "postgres", backupDatabaseSegment(database), "latest.json"].join("/");
}

/**
 * Ключ, который разрешено читать. Манифест приходит из бакета, то есть его содержимое не
 * доверенное: без этой проверки подменённый `latest.json` заставил бы восстановление скачать
 * любой объект бакета — например, чужой архив проекта.
 */
export function validateBackupKey(prefix: string, key: string) {
  const root = prefixOf(prefix) + "/backups/postgres/";
  if (!key.startsWith(root)) throw new Error("Ключ резервной копии вне каталога бэкапов: " + key);
  if (!/^[A-Za-z0-9._/-]+$/.test(key)) throw new Error("Некорректный ключ резервной копии: " + key);
  if (key.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Некорректный ключ резервной копии: " + key);
  }
  // Восстановлению разрешён только дамп в датированном каталоге, а не `latest.json` и не
  // архив проекта: манифест лежит в том же бакете и не должен уметь подсунуть любой объект.
  if (!/\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]+\.dump$/.test(key)) {
    throw new Error("Ключ резервной копии не похож на дамп: " + key);
  }
  return key;
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

/** Пишет поток в файл с правами 0600 и считает байты; больше потолка — ошибка до загрузки. */
async function writeInput(input: Readable, filePath: string, maxBytes: number) {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        done(new Error("Дамп больше предела " + maxBytes + " байт"));
        return;
      }
      done(null, chunk);
    },
  });
  await pipeline(input, counter, createWriteStream(filePath, { mode: 0o600 }));
  return bytes;
}

function parseManifestText(text: string, prefix: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Манифест последнего бэкапа — не JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Манифест последнего бэкапа пуст");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) throw new Error("Неизвестная версия манифеста бэкапа: " + String(record.version));
  const database = typeof record.database === "string" ? record.database : "";
  const key = typeof record.key === "string" ? record.key : "";
  const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  const bytes = typeof record.bytes === "number" ? record.bytes : Number.NaN;
  backupDatabaseSegment(database);
  validateBackupKey(prefix, key);
  if (!key.startsWith([prefixOf(prefix), "backups", "postgres", backupDatabaseSegment(database)].join("/") + "/")) {
    throw new Error("Манифест указывает на бэкап другой базы");
  }
  if (!SHA256.test(sha256)) throw new Error("В манифесте бэкапа нет корректной контрольной суммы");
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("В манифесте бэкапа некорректный размер");
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error("В манифесте бэкапа некорректная дата");
  return { version: 1, database, key, bytes, sha256, createdAt };
}

/** Загружает дамп и только затем публикует манифест, подтверждая размер обоих объектов. */
export async function putBackup(options: PutBackupOptions): Promise<BackupManifest> {
  const now = options.now ?? new Date();
  const dir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "wnd-pg-backup-"));
  const dumpPath = path.join(dir, "dump");
  try {
    const bytes = await writeInput(options.input, dumpPath, options.maxBytes ?? MAX_DUMP_BYTES);
    if (bytes === 0) throw new Error("Пустой дамп: pg_dump ничего не записал");
    const sha256 = await sha256File(dumpPath);
    const key = backupObjectKey(options.store.prefix, options.database, now);

    const uploaded = await options.store.putFile(key, dumpPath, "application/octet-stream");
    if (uploaded !== bytes) throw new Error("Загружено " + uploaded + " байт вместо " + bytes);
    const head = await options.store.head(key);
    if (!head) throw new Error("Хранилище не подтвердило загрузку дампа: " + key);
    if (head.size !== bytes) throw new Error("Хранилище сообщает размер " + head.size + " вместо " + bytes);

    const manifest: BackupManifest = {
      version: 1,
      database: options.database,
      key,
      bytes,
      sha256,
      createdAt: now.toISOString(),
    };
    const manifestPath = path.join(dir, "latest.json");
    const manifestText = JSON.stringify(manifest) + "\n";
    await writeFile(manifestPath, manifestText, { mode: 0o600 });
    const manifestKey = manifestObjectKey(options.store.prefix, options.database);
    const manifestBytes = Buffer.byteLength(manifestText);
    const uploadedManifest = await options.store.putFile(manifestKey, manifestPath, "application/json");
    if (uploadedManifest !== manifestBytes) throw new Error("Манифест загружен не полностью");
    const manifestHead = await options.store.head(manifestKey);
    if (!manifestHead || manifestHead.size !== manifestBytes) {
      throw new Error("Хранилище не подтвердило загрузку манифеста: " + manifestKey);
    }
    return manifest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Последний манифест базы. Отдельная функция, потому что его читают и проверка, и восстановление. */
export async function readManifest(store: ObjectStore, database: string, tempRoot?: string): Promise<BackupManifest> {
  const dir = await mkdtemp(path.join(tempRoot ?? tmpdir(), "wnd-pg-manifest-"));
  const file = path.join(dir, "latest.json");
  try {
    const found = await store.getToFile(manifestObjectKey(store.prefix, database), file);
    if (!found) throw new Error("В хранилище нет ни одного бэкапа базы " + database);
    return parseManifestText(await readFile(file, "utf8"), store.prefix);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Свежесть и целостность последнего бэкапа. Проверка не скачивает дамп: `HEAD` отвечает на
 * вопрос «объект на месте и того же размера» без трафика, а возраст берётся из манифеста.
 */
export async function checkBackup(options: CheckBackupOptions) {
  const manifest = await readManifest(options.store, options.database, options.tempRoot);
  const maxAgeHours = options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const now = options.now ?? new Date();
  const ageHours = Math.max(0, (now.getTime() - Date.parse(manifest.createdAt)) / 3_600_000);
  if (ageHours > maxAgeHours) {
    throw new Error(
      "Последний бэкап базы " + options.database + " старше " + maxAgeHours + " ч: " +
      ageHours.toFixed(1) + " ч (" + manifest.createdAt + ")",
    );
  }
  const head = await options.store.head(manifest.key);
  if (!head) throw new Error("Манифест указывает на отсутствующий объект: " + manifest.key);
  if (head.size !== manifest.bytes) {
    throw new Error("Размер бэкапа в хранилище (" + head.size + ") не совпадает с манифестом (" + manifest.bytes + ")");
  }
  return { manifest, ageHours };
}

/** Скачивает дамп, проверяет контрольную сумму и отдаёт его вызывающему потоку. */
export async function readBackup(options: ReadBackupOptions) {
  validateBackupKey(options.store.prefix, options.key);
  if (!SHA256.test(options.sha256)) throw new Error("Некорректная контрольная сумма бэкапа");
  const dir = await mkdtemp(path.join(options.tempRoot ?? tmpdir(), "wnd-pg-restore-"));
  const file = path.join(dir, "dump");
  try {
    const found = await options.store.getToFile(options.key, file);
    if (!found) throw new Error("Бэкап не найден в хранилище: " + options.key);
    const actual = await sha256File(file);
    if (actual !== options.sha256) {
      throw new Error("Контрольная сумма бэкапа не совпала: ожидалась " + options.sha256 + ", получена " + actual);
    }
    const info = await stat(file);
    await pipeline(createReadStream(file), options.output);
    return info.size;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
