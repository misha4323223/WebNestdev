import { readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { isSecretProjectPath } from "../secrets/secret-paths.js";

/**
 * ZIP для выгрузки проекта: человек забирает архивом то, что собрал агент, и открывает проект
 * локально или в любом другом редакторе. Раньше забрать проект было нечем — оставался только
 * GitHub, а это другой сценарий (репозиторий, ветка, права).
 *
 * Архив собирается потоком, а не целиком в памяти: папки с зависимостями пропускаются, но
 * проект с картинками и шрифтами всё равно весит десятки мегабайт. Каждый файл сжимается
 * отдельно; если сжатие ничего не даёт (png, jpg, шрифт), он кладётся как есть — так архив
 * не раздувается на уже сжатых данных.
 *
 * Имена пишутся в UTF-8 и с флагом UTF-8 в заголовке: без него русские имена файлов в
 * некоторых распаковщиках превращались в мусор.
 */

/** Папки, которых в архиве быть не должно: зависимости, история и служебные данные платформы. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".webnestdev"]);
/** Больше этого файлов ZIP без ZIP64 уже не описать — честная ошибка вместо битого архива. */
const MAX_ENTRIES = 60_000;

const UTF8_FLAG = 0x0800;
const STORE = 0;
const DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Время в формате DOS: секунды хранятся с шагом 2, год отсчитывается от 1980. */
function dosStamp(info: Stats) {
  const date = info.mtime instanceof Date ? info.mtime : new Date();
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

type Entry = {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
  compressed: number;
  size: number;
  stamp: { time: number; date: number };
  /** Каталог — пустая запись с завершающим `/`, чтобы пустые папки тоже доехали. */
  directory: boolean;
};

function localHeader(entry: Entry) {
  const name = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.stamp.time, 10);
  header.writeUInt16LE(entry.stamp.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader(entry: Entry, offset: number) {
  const name = Buffer.from(entry.name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.stamp.time, 12);
  header.writeUInt16LE(entry.stamp.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  // Права файла: обычный файл 0644 (или каталог), иначе распаковщик ставит свои.
  header.writeUInt32LE(((entry.directory ? 0o40755 : 0o100644) << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function entryOf(name: string, data: Buffer, info: Stats, directory: boolean): Entry {
  const stamp = dosStamp(info);
  if (directory) return { name: name.endsWith("/") ? name : name + "/", data: Buffer.alloc(0), crc: 0, method: STORE, compressed: 0, size: 0, stamp, directory };
  const deflated = deflateRawSync(data, { level: 6 });
  const store = deflated.length >= data.length;
  return {
    name,
    data: store ? data : deflated,
    crc: crc32(data),
    method: store ? STORE : DEFLATE,
    compressed: store ? data.length : deflated.length,
    size: data.length,
    stamp,
    directory,
  };
}

/** Имя папки внутри архива: проект распаковывается в свою папку, а не в текущую. */
export function archiveFolderName(projectName: string) {
  const safe = projectName
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
  return safe || "project";
}

type Walked = { relative: string; full: string; info: Stats; directory: boolean };

async function* walk(root: string, prefix: string): AsyncGenerator<Walked> {
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const dir = queue[index];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      // Ссылки не раскрываются и не копируются: архив не должен тянуть файл из-за пределов проекта.
      if (entry.isSymbolicLink()) continue;
      if (isSecretProjectPath(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const info = await lstat(full).catch(() => null);
        if (!info) continue;
        yield { relative: prefix + relative, full, info, directory: true };
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      yield { relative: prefix + relative, full, info, directory: false };
    }
  }
}

/**
 * Поток архива проекта. `prefix` — папка внутри архива (обычно имя проекта), чтобы распаковка
 * не рассыпала файлы в текущий каталог.
 */
export async function* zipProject(root: string, prefix = ""): AsyncGenerator<Buffer> {
  const folder = prefix ? prefix.replace(/\/+$/, "") + "/" : "";
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for await (const file of walk(root, folder)) {
    if (count >= MAX_ENTRIES) throw new Error("В проекте слишком много файлов для одного архива");
    const data = file.directory ? Buffer.alloc(0) : await readFile(file.full).catch(() => null);
    if (!file.directory && !data) continue;
    const entry = entryOf(file.relative, data ?? Buffer.alloc(0), file.info, file.directory);
    const header = localHeader(entry);
    yield header;
    if (entry.data.length) yield entry.data;
    central.push(centralHeader(entry, offset));
    offset += header.length + entry.data.length;
    count++;
  }
  const directory = Buffer.concat(central);
  yield directory;
  yield endOfCentralDirectory(count, directory.length, offset);
}
