import { chmod, chown, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Команды проекта выполняются в контейнере от uid 1000, а файлы проекта пишет сервер от root.
 * Файл root:root 644 контейнер читает, но не меняет, поэтому сборка в подкаталоге, установка
 * пакетов рядом с такими файлами и `chmod` изнутри падают на EPERM.
 *
 * Открывать всё `chmod 666` нельзя: мир-записываемый `.env` — это чужой процесс на хосте,
 * который дописывает в него свой код и ждёт запуска предпросмотра. Поэтому владелец файлов —
 * uid контейнера (1000), обычные файлы 664, каталоги 775, а файлы окружения — 600: контейнер
 * их читает и пишет как владелец, остальные пользователи хоста — нет. Если сменить владельца
 * нельзя (сервер запущен не от root, например локально), остаются прежние 666/777: без этого
 * контейнер вообще не смог бы писать в проект. Права — не повод падать: если что-то осталось
 * закрытым, об этом скажет сама команда.
 */

const SANDBOX_UID = 1000;
const SANDBOX_GID = 1000;

/** Права, когда владелец — uid контейнера. */
const DIR_MODE = 0o775;
const FILE_MODE = 0o664;
const SECRET_MODE = 0o600;
/** Запасной вариант, когда chown недоступен: контейнер пишет как «остальные». */
const DIR_FALLBACK = 0o777;
const FILE_FALLBACK = 0o666;
const SECRET_FALLBACK = 0o644;

/**
 * Каталоги, которые наполняет сам контейнер: обход по ним ничего не исправляет, но дорог.
 * `.git` пропускается здесь не потому, что контейнер его наполняет, а потому что его наполняет
 * **сервер** (isomorphic-git от root) — у него отдельный обход, см. openGitForSandbox.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".vite", ".turbo"]);
/** Потолок разового обхода: большое дерево лечится частично, но не тормозит первый вызов. */
const TREE_LIMIT = 20000;

/**
 * Файл окружения проекта. `.env.example` и его аналоги — шаблоны без секретов, их можно
 * показывать и коммитить; всё остальное (`.env`, `.env.local`, `.env.production.local`)
 * содержит ключи и не должно быть доступно никому, кроме владельца-контейнера и root.
 */
export function isSecretEnvFile(name: string) {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !/\.(example|sample|template)$/.test(name);
}

async function own(target: string) {
  try {
    await chown(target, SANDBOX_UID, SANDBOX_GID);
    return true;
  } catch {
    return false;
  }
}

async function open(target: string, mode: number, fallback: number, keepExec = false) {
  try {
    const info = await lstat(target);
    // chmod по ссылке меняет права её цели, а не ссылки: цель может быть чужим файлом.
    if (info.isSymbolicLink()) return;
    const owned = await own(target);
    // Бит исполнения сохраняется: обход повторяется перед каждой командой контейнера, а скрипт,
    // которому агент выставил `chmod +x`, без этого перестал бы запускаться после первой же
    // команды (`. ./scripts/deploy.sh`).
    const exec = keepExec ? info.mode & 0o111 : 0;
    await chmod(target, (owned ? mode : fallback) | exec);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[sandbox] не удалось выставить права на ${target}`, error);
    }
  }
}

/** Каталог для контейнера: создание в нём node_modules, dist и прочего. */
export function openDirForSandbox(dir: string) {
  return open(dir, DIR_MODE, DIR_FALLBACK);
}

/** Файл, записанный сервером: контейнер должен уметь его перезаписать. */
export function openFileForSandbox(file: string) {
  // У файла окружения бит исполнения не нужен и только расширял бы права: ключи — всегда 600.
  return isSecretEnvFile(path.basename(file))
    ? open(file, SECRET_MODE, SECRET_FALLBACK)
    : open(file, FILE_MODE, FILE_FALLBACK, true);
}

/** Каталог, в который сервер положил файл, и все его родители до корня песочницы включительно. */
export async function openDirsForSandbox(root: string, dir: string) {
  const stop = path.resolve(root);
  let current = path.resolve(dir);
  while (current === stop || current.startsWith(stop + path.sep)) {
    await openDirForSandbox(current);
    if (current === stop) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Размер `.git`, который обходится: каталоги обновляются раньше файлов, этого хватает для записи. */
const GIT_LIMIT = 20000;

/**
 * Файл внутри `.git`: владелец — контейнер, бит записи владельца выставлен, остальные биты
 * (в том числе x у хуков) не трогаются. Если chown недоступен (сервер не от root), файл
 * открывается всем на запись — иначе `git add` в контейнере упадёт на EACCES.
 */
async function openGitFile(target: string) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return;
    const mode = info.mode & 0o7777;
    if (info.uid === SANDBOX_UID) {
      if ((mode & 0o200) === 0) await chmod(target, mode | 0o200);
      return;
    }
    const owned = await own(target);
    await chmod(target, owned ? mode | 0o200 : mode | 0o222);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[sandbox] не удалось открыть файл git ${target}`, error);
    }
  }
}

/**
 * `.git` создаёт и обновляет сервер (isomorphic-git) от root, а `git` в контейнере работает от
 * uid 1000. Поэтому `git status` ещё читался, а `git add`, `commit` и `pull` падали: `git`
 * отказывался работать в чужом репозитории (`dubious ownership`), а запись в `.git/FETCH_HEAD`
 * и `.git/index` упиралась в `Permission denied`. Открываем сам каталог и его содержимое перед
 * каждой командой контейнера: сервер дописывает туда файлы от root, и без этого они снова
 * оказались бы закрыты. Уже открытые элементы проверяются одним lstat и пропускаются.
 */
export async function openGitForSandbox(root: string, limit = GIT_LIMIT) {
  const gitDir = path.join(path.resolve(root), ".git");
  const info = await lstat(gitDir).catch(() => null);
  // `.git` может быть файлом (worktree) — тогда открывать нечего, права у основного каталога.
  if (!info?.isDirectory()) return false;
  const stack = [gitDir];
  let seen = 0;
  while (stack.length && seen < limit) {
    const current = stack.pop() as string;
    await openDirForSandbox(current);
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (seen >= limit) break;
      seen++;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) await openGitFile(full);
    }
  }
  return true;
}

/**
 * Временные каталоги Vite. Если их успел создать root (старый запуск сборки), контейнер не может
 * ни писать в них, ни заменить: Vite падает с EACCES на `node_modules/.vite-temp`. Это кеш, а не
 * данные проекта — удалять его безопасно, и Vite создаст свой от uid 1000.
 */
export async function clearRootOwnedBuildCaches(root: string) {
  let removed = 0;
  for (const relative of ["node_modules/.vite-temp", "node_modules/.vite"]) {
    const target = path.join(root, relative);
    const info = await lstat(target).catch(() => null);
    if (!info || info.uid === SANDBOX_UID) continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed++;
    } catch (error) {
      console.warn(`[sandbox] не удалось убрать ${target}`, error);
    }
  }
  return removed;
}

/**
 * Разовое открытие уже существующего дерева: проект, собранный до этого исправления (или
 * скопированный в песочницу), лежит root:root с 644, и агент не может в нём собрать ничего.
 * node_modules и .git пропускаются: у node_modules владелец — контейнер, у .git — отдельный обход.
 *
 * Вызывается не только при первом доступе, но и перед каждой командой контейнера
 * (openProjectForSandbox): каталог может создать любой путь сервера — клон репозитория,
 * распаковка архива, переключение ветки, — и `npm run build` упирается в EACCES уже после того,
 * как агент потратил шаги на поиск причины.
 */
export async function openTreeForSandbox(root: string, limit = TREE_LIMIT) {
  const stack = [path.resolve(root)];
  let seen = 0;
  while (stack.length && seen < limit) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (seen >= limit) break;
      seen++;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // Содержимое node_modules обходить дорого и незачем, но сам каталог открывается: если
        // его создала установка от root, контейнер не добавит и не заменит в нём ни один пакет.
        if (SKIP_DIRS.has(entry.name)) {
          if (entry.name === "node_modules") await openDirForSandbox(full);
          continue;
        }
        await openDirForSandbox(full);
        stack.push(full);
        continue;
      }
      if (entry.isFile()) await openFileForSandbox(full);
    }
  }
}

/**
 * Всё, что нужно контейнеру перед командой: корень, дерево проекта и (если есть) `.git`. Один
 * вызов на команду — единственное место, где права проверяются заново, поэтому проект остаётся
 * собираемым, кто бы ни создал каталоги до этого.
 */
export async function openProjectForSandbox(root: string) {
  await openDirForSandbox(root);
  await openTreeForSandbox(root);
  await openGitForSandbox(root);
}
