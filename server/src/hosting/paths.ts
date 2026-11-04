import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { assertSitesDirSeparate, hostingSitesDir } from "./config.js";
import { assertHostingReleaseId, assertHostingSlug } from "./slug.js";

/** Внутри одного `SITES_DIR` живут только каталоги сайтов и служебные каталоги. */
const SITE_DIRS = ["releases", "tmp", "trash", "manifests"] as const;

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function assertInsideHostingRoot(root: string, candidate: string) {
  const safeRoot = path.resolve(root);
  const target = path.resolve(candidate);
  if (!inside(safeRoot, target)) throw new Error("Путь выходит за пределы SITES_DIR");
  return target;
}

export function hostingSiteDir(slug: string, root = hostingSitesDir()) {
  assertHostingSlug(slug);
  return path.join(path.resolve(root), slug);
}

export function hostingReleasesDir(slug: string, root = hostingSitesDir()) {
  return path.join(hostingSiteDir(slug, root), "releases");
}

export function hostingTmpDir(slug: string, root = hostingSitesDir()) {
  return path.join(hostingSiteDir(slug, root), "tmp");
}

export function hostingTrashDir(slug: string, root = hostingSitesDir()) {
  return path.join(hostingSiteDir(slug, root), "trash");
}

export function hostingManifestsDir(slug: string, root = hostingSitesDir()) {
  return path.join(hostingSiteDir(slug, root), "manifests");
}

export function hostingReleaseDir(slug: string, releaseId: string, root = hostingSitesDir()) {
  assertHostingReleaseId(releaseId);
  return path.join(hostingReleasesDir(slug, root), releaseId);
}

export function hostingCurrentLink(slug: string, root = hostingSitesDir()) {
  return path.join(hostingSiteDir(slug, root), "current");
}

/** Manifest намеренно лежит вне `current`: Caddy не должен отдавать его как файл сайта. */
export function hostingManifestPath(slug: string, releaseId: string, root = hostingSitesDir()) {
  assertHostingReleaseId(releaseId);
  return path.join(hostingManifestsDir(slug, root), releaseId + ".json");
}

export function hostingStagingPath(slug: string, releaseId: string, root = hostingSitesDir()) {
  assertHostingReleaseId(releaseId);
  return path.join(hostingTmpDir(slug, root), releaseId);
}

/**
 * Корень сайтов создаётся только сервером, от uid сервера. Caddy монтирует его read-only.
 * Символическая ссылка на месте корня или каталога сайта — это не «почти нормально»: она
 * могла бы увести запись релиза в data или в чужой каталог, поэтому отвергается до mkdir.
 */
export async function ensureHostingRoot(root = hostingSitesDir()) {
  const target = path.resolve(root);
  assertSitesDirSeparate(target);
  await mkdir(target, { recursive: true, mode: 0o755 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("SITES_DIR должен быть обычным каталогом, а не символической ссылкой");
  }
  return target;
}

export async function ensureSiteLayout(slug: string, root = hostingSitesDir()) {
  await ensureHostingRoot(root);
  const site = hostingSiteDir(slug, root);
  await mkdir(site, { recursive: true, mode: 0o755 });
  const info = await lstat(site);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Каталог сайта не является обычным каталогом");
  }
  for (const name of SITE_DIRS) {
    const dir = path.join(site, name);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
      throw new Error("Служебный каталог сайта не является обычным каталогом: " + name);
    }
  }
  return site;
}

async function readCurrentRaw(slug: string, root: string) {
  const link = hostingCurrentLink(slug, root);
  const info = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isSymbolicLink()) throw new Error("current должен быть символической ссылкой");
  return readlink(link);
}

/**
 * Проверка current: только относительная ссылка строго на `releases/<releaseId>` этого сайта.
 * Возвращает null, если ссылки нет. Абсолютная ссылка, `..`, ссылка на другой сайт и
 * ссылка на `tmp` отвергаются.
 */
export async function readCurrentReleaseId(slug: string, root = hostingSitesDir()): Promise<string | null> {
  const raw = await readCurrentRaw(slug, root);
  if (!raw) return null;
  if (path.isAbsolute(raw) || raw.includes("\0")) throw new Error("current указывает за пределы сайта");
  const normalized = raw.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.length !== 2 || parts[0] !== "releases") throw new Error("current указывает не на releases");
  const releaseId = parts[1] ?? "";
  assertHostingReleaseId(releaseId);
  const releases = path.resolve(hostingReleasesDir(slug, root));
  const target = path.resolve(hostingSiteDir(slug, root), normalized);
  if (target !== path.join(releases, releaseId)) throw new Error("current указывает за пределы releases");
  return releaseId;
}

async function fsyncDir(dir: string) {
  // На Linux rename симлинка атомарен, но без fsync каталога после внезапного выключения
  // питания можно получить старую запись. Ошибка fsync не должна превращать успешную
  // публикацию в отказ: файловая система может не поддерживать открытие каталога.
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } catch {
    // best-effort: reconcile при старте всё равно сравнит current и БД
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Атомарное переключение `current`. Временная ссылка создаётся в каталоге сайта, затем
 * переименовывается поверх старой. Возвращает предыдущую цель — она нужна, чтобы откатить
 * переключение, если запись в БД не удалась.
 */
export async function switchCurrent(
  slug: string,
  releaseId: string,
  root = hostingSitesDir(),
): Promise<string | null> {
  const site = await ensureSiteLayout(slug, root);
  const target = hostingReleaseDir(slug, releaseId, root);
  const releaseInfo = await lstat(target).catch(() => null);
  if (!releaseInfo?.isDirectory() || releaseInfo.isSymbolicLink()) {
    throw new Error("Релиз не найден на диске");
  }
  const previous = await readCurrentReleaseId(slug, root);
  const link = hostingCurrentLink(slug, root);
  const temp = path.join(site, ".current-" + releaseId + "-" + process.pid + "-" + Date.now());
  await symlink(path.join("releases", releaseId), temp, "dir");
  try {
    await rename(temp, link);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await fsyncDir(site);
  return previous;
}

/** Снять сайт с публикации на файловом уровне. Ошибка ENOENT означает, что он уже снят. */
export async function removeCurrent(slug: string, root = hostingSitesDir()) {
  const link = hostingCurrentLink(slug, root);
  try {
    await unlink(link);
    await fsyncDir(path.dirname(link));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeSiteDirectory(slug: string, root = hostingSitesDir()) {
  const dir = hostingSiteDir(slug, root);
  assertInsideHostingRoot(root, dir);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Переименование каталога сайта вместе с релизами и относительной ссылкой `current`.
 * Оба имени уже проверены как slug, поэтому `..` сюда не попадает. Если каталога ещё нет
 * (сайт создан, но не публиковался), это не ошибка: меняется только запись в БД.
 * Существующий целевой каталог — конфликт: иначе можно было бы подхватить чужие/осиротевшие
 * файлы под новым адресом.
 */
export async function renameSiteDirectory(oldSlug: string, newSlug: string, root = hostingSitesDir()) {
  const from = hostingSiteDir(oldSlug, root);
  const to = hostingSiteDir(newSlug, root);
  if (from === to) return false;
  const target = await lstat(to).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (target) {
    const conflict = new Error("Каталог с новым адресом уже существует") as NodeJS.ErrnoException;
    conflict.code = "EEXIST";
    throw conflict;
  }
  const source = await lstat(from).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!source) return false;
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error("Каталог сайта не является обычным каталогом");
  }
  await rename(from, to);
  await fsyncDir(path.dirname(from));
  return true;
}

/** Для тестов и восстановления: ссылка создаётся только после проверки существования релиза. */
export async function restoreCurrent(slug: string, releaseId: string, root = hostingSitesDir()) {
  return switchCurrent(slug, releaseId, root);
}
