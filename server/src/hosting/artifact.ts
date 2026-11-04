import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { HostingError } from "./types.js";
import { isForbiddenArtifactDir, isForbiddenArtifactName, isSourceMap, scanTextForSecrets } from "./security.js";

/**
 * Проверка и копирование статического артефакта.
 *
 * Это вторая линия после изоляции сборки: даже если build-скрипт положил в output симлинк,
 * `.env` или ключ, релиз не должен попасть на публичный адрес. Копирование идёт с
 * `O_NOFOLLOW`, без `cp -a`, с проверкой hardlink/device/FIFO и повторным SHA-256 при записи.
 */

export type ArtifactLimits = {
  maxReleaseBytes: number;
  maxFileBytes: number;
  maxFiles: number;
};

export type ArtifactFile = { path: string; bytes: number; sha256: string };
export type ArtifactManifest = {
  version: 1;
  files: ArtifactFile[];
  bytes: number;
  filesCount: number;
  sha256: string;
};

export type ArtifactOptions = {
  limits: ArtifactLimits;
  /** Точные значения секретов проекта; только сервер, только для сравнения. */
  secretValues?: string[];
  allowSourceMaps?: boolean;
  /** Корень проекта: output не должен быть симлинком за его пределы. */
  projectRoot?: string;
};

const MAX_DEPTH = 32;
const MAX_RELATIVE_PATH = 512;
const MAX_NAME = 255;

function artifactError(message: string): never {
  throw new HostingError("ARTIFACT_INVALID", message, 422);
}

function normalizeRelative(value: string) {
  return value.replaceAll("\\", "/");
}

function validateRelative(relative: string) {
  if (!relative || relative.includes("\0")) artifactError("В релизе пустое или недопустимое имя файла");
  if (relative.length > MAX_RELATIVE_PATH) artifactError("Слишком длинный путь в релизе: " + relative.slice(0, 80) + "…");
  const parts = normalizeRelative(relative).split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.length > MAX_NAME) {
      artifactError("Недопустимый путь в релизе: " + relative);
    }
  }
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(file: string) {
  return createHash("sha256").update(file).digest("hex");
}

function diskBytes(info: Stats) {
  // Разреженный файл может иметь маленький size и большой физический размер; для квоты важнее
  // второе. На файловых системах без blocks используем size.
  return Math.max(info.size, Number(info.blocks ?? 0) * 512);
}

type WalkFile = { relative: string; full: string; info: Stats };

async function walkSource(source: string, limits: ArtifactLimits, options: ArtifactOptions): Promise<WalkFile[]> {
  const rootInfo = await lstat(source).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) artifactError("Каталог сборки не является обычным каталогом");
  const files: WalkFile[] = [];
  let total = 0;
  const seen = new Set<string>();

  async function visit(dir: string, relativeDir: string, depth: number) {
    if (depth > MAX_DEPTH) artifactError("Слишком глубокая вложенность каталогов в релизе");
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeDir ? relativeDir + "/" + entry.name : entry.name;
      validateRelative(relative);
      if (isForbiddenArtifactName(entry.name, entry.name === ".well-known")) continue;
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) artifactError("Символическая ссылка в релизе запрещена: " + relative);
      if (info.isDirectory()) {
        if (isForbiddenArtifactDir(entry.name)) continue;
        await visit(full, relative, depth + 1);
        continue;
      }
      if (!info.isFile()) artifactError("В релизе допустимы только обычные файлы: " + relative);
      if (info.nlink > 1) artifactError("Жёсткая ссылка в релизе запрещена: " + relative);
      if (info.size > limits.maxFileBytes) artifactError("Файл больше лимита: " + relative);
      if (isSourceMap(entry.name) && !options.allowSourceMaps) artifactError("Source map запрещён в публичном релизе: " + relative);
      total += diskBytes(info);
      if (total > limits.maxReleaseBytes) artifactError("Релиз больше лимита " + Math.round(limits.maxReleaseBytes / 1024 / 1024) + " МиБ");
      if (files.length + 1 > limits.maxFiles) artifactError("В релизе больше " + limits.maxFiles + " файлов");
      files.push({ relative, full, info });
    }
  }

  await visit(source, "", 0);
  return files;
}

/**
 * Полная проверка до копирования. Возвращает манифест; сам output не изменяется.
 */
export async function inspectArtifact(sourceDir: string, options: ArtifactOptions): Promise<ArtifactManifest> {
  const source = path.resolve(sourceDir);
  if (options.projectRoot) {
    const projectRoot = await realpath(options.projectRoot).catch(() => path.resolve(options.projectRoot!));
    const realSource = await realpath(source).catch(() => null);
    if (!realSource || !(realSource === projectRoot || realSource.startsWith(projectRoot + path.sep))) {
      artifactError("Каталог сборки находится за пределами проекта");
    }
  }
  const index = await lstat(path.join(source, "index.html")).catch(() => null);
  if (!index?.isFile() || index.isSymbolicLink()) artifactError("В корне релиза нет обычного index.html");

  const files = await walkSource(source, options.limits, options);
  const manifestFiles: ArtifactFile[] = [];
  let bytes = 0;
  for (const file of files) {
    const handle = await open(file.full, constants.O_RDONLY | constants.O_NOFOLLOW);
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > options.limits.maxFileBytes) {
        artifactError("Файл изменился во время проверки: " + file.relative);
      }
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (data.byteLength !== file.info.size) artifactError("Файл изменился во время проверки: " + file.relative);
    const text = data.includes(0) ? "" : data.toString("utf8");
    if (text) {
      const findings = scanTextForSecrets(text, options.secretValues ?? [], file.relative);
      if (findings.length) {
        artifactError("В релизе найдены данные, похожие на секрет: " + findings[0].path + " (" + findings[0].kind + ")");
      }
    }
    bytes += diskBytes(file.info);
    manifestFiles.push({ path: file.relative, bytes: file.info.size, sha256: sha256(data) });
  }
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  const treeHash = hashFile(manifestFiles.map(file => file.path + "\0" + file.bytes + "\0" + file.sha256).join("\n"));
  return {
    version: 1,
    files: manifestFiles,
    bytes,
    filesCount: manifestFiles.length,
    sha256: treeHash,
  };
}

/**
 * Копирует уже проверенный артефакт в пустой staging-каталог. Повторно сверяет SHA-256:
 * между inspect и copy build-процесс уже завершён, но файл мог измениться внешним процессом.
 */
export async function copyArtifact(
  sourceDir: string,
  destinationDir: string,
  manifest: ArtifactManifest,
  options: ArtifactOptions,
): Promise<void> {
  const source = path.resolve(sourceDir);
  const destination = path.resolve(destinationDir);
  await mkdir(destination, { recursive: false, mode: 0o755 });
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  let total = 0;

  for (const file of manifest.files) {
    const sourcePath = path.join(source, file.path);
    const targetPath = path.join(destination, file.path);
    const relative = normalizeRelative(path.relative(destination, targetPath));
    validateRelative(relative);
    if (relative !== file.path) artifactError("Путь копирования не совпадает с манифестом");
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    const sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await sourceHandle.stat();
      if (!info.isFile() || info.nlink > 1 || info.size > options.limits.maxFileBytes) {
        artifactError("Источник изменился во время копирования: " + file.path);
      }
      const data = await sourceHandle.readFile();
      if (sha256(data) !== expected.get(file.path)?.sha256) {
        artifactError("Файл изменился после проверки: " + file.path);
      }
      const targetHandle = await open(
        targetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      try {
        await targetHandle.writeFile(data);
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      total += diskBytes(info);
      if (total > options.limits.maxReleaseBytes) artifactError("Релиз больше лимита при копировании");
    } finally {
      await sourceHandle.close();
    }
  }

  // Пустые каталоги в манифест не входят; для статики они не нужны. Права фиксируем явно,
  // чтобы Caddy читал файлы, но не получил исполняемые биты от сборки. Манифест лежит в
  // `manifests/` и в БД, не внутри `current`: Caddy не должен отдавать его как файл сайта.
  await chmod(destination, 0o755);
}

/** Удаляет staging после ошибки. Ошибка уборки не должна скрывать исходную. */
export async function removeStaging(directory: string) {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

export async function directorySize(dir: string) {
  const info = await stat(dir).catch(() => null);
  return info?.size ?? 0;
}
