import { chmod, chown, lstat, readdir } from "node:fs/promises";
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

/** Каталоги, которые наполняет сам контейнер: обход по ним ничего не исправляет, но дорог. */
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

async function open(target: string, mode: number, fallback: number) {
  try {
    const info = await lstat(target);
    // chmod по ссылке меняет права её цели, а не ссылки: цель может быть чужим файлом.
    if (info.isSymbolicLink()) return;
    const owned = await own(target);
    await chmod(target, owned ? mode : fallback);
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
  return isSecretEnvFile(path.basename(file))
    ? open(file, SECRET_MODE, SECRET_FALLBACK)
    : open(file, FILE_MODE, FILE_FALLBACK);
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

/**
 * Разовое открытие уже существующего дерева: проект, собранный до этого исправления (или
 * скопированный в песочницу), лежит root:root с 644, и агент не может в нём собрать ничего.
 * node_modules и .git пропускаются: их наполняет контейнер, и обход стоит тысяч вызовов.
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
        if (SKIP_DIRS.has(entry.name)) continue;
        await openDirForSandbox(full);
        stack.push(full);
        continue;
      }
      if (entry.isFile()) await openFileForSandbox(full);
    }
  }
}
