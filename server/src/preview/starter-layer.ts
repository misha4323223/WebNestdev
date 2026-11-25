import { spawn } from "node:child_process";
import { readFile, readdir, rm, stat, writeFile, chown, chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { sandboxImage } from "../sandbox/config.js";
import { SANDBOX_GID, SANDBOX_UID } from "../sandbox/permissions.js";
import {
  DEPENDENCY_CACHE_MARKER,
  dependencyCacheEnabled,
  dependencyCacheNodeModulesDir,
  dependencyCacheRoot,
  dependencyHashFrom,
  ensureDependencyCacheLocal,
} from "./dependency-cache.js";

/**
 * Предустановленный слой зависимостей.
 *
 * Идея: типовой проект ставит один и тот же набор пакетов одних и тех же версий. Если такой
 * набор уже распакован на ноде, `npm install` не нужен вообще — дерево приходит из слоя
 * жёсткими ссылками, а маркер кэша получает хэш проекта, поэтому существующая проверка
 * `dependencyEnsureCommand` видит «cached» и установку не запускает.
 *
 * Границы, без которых это было бы опасно:
 * - Только точное совпадение. Хэш считается по тому же контракту, что и
 *   `dependencyLockHash` (образ + `package.json` + lock + shrinkwrap). Проект со своими
 *   версиями (частый случай: человек написал промт, агент выбрал пакеты сам) слой просто
 *   не получит и пойдёт обычным путём. Ничего не «догадываемся».
 * - Слой только читают. Файлы в нём `0444`, каталоги принадлежат uid песочницы, чтобы проект
 *   мог удалить дерево, но не мог переписать файл во всех проектах сразу. `cp -al` создаёт
 *   собственные каталоги и жёсткие ссылки на файлы, поэтому `node_modules/.vite` остаётся
 *   обычным записываемым каталогом проекта.
 * - Слой лежит вне корня кэша проектов: уборщик и квота считают каждый каталог в
 *   `dependencyCacheRoot()` проектом и удалили бы слой как сироту.
 * - Любая ошибка — это «слоя нет», а не ошибка установки.
 */

export function starterLayerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.WEBNESTDEV_STARTER_LAYER?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

/** Каталог набора (исходные `package.json` и lock), из которого собран слой. */
export function starterKitDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.WEBNESTDEV_STARTER_KIT_DIR?.trim();
  return configured ? path.resolve(configured) : null;
}

/** Корень слоёв на ноде: рядом с кэшем проектов, но не внутри него. */
export function starterLayerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WEBNESTDEV_STARTER_LAYER_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(dependencyCacheRoot()), "webnestdev-starter-layers");
}

export type StarterKit = { dir: string; hash: string };

/** Файлы набора; `null` — набор не задан или в нём нет `package.json`. */
export async function readStarterKit(env: NodeJS.ProcessEnv = process.env): Promise<StarterKit | null> {
  const dir = starterKitDir(env);
  if (!dir) return null;
  const packageJson = await readFile(path.join(dir, "package.json"), "utf8").catch(() => null);
  if (packageJson === null) return null;
  const [lock, shrinkwrap] = await Promise.all([
    readFile(path.join(dir, "package-lock.json"), "utf8").catch(() => ""),
    readFile(path.join(dir, "npm-shrinkwrap.json"), "utf8").catch(() => ""),
  ]);
  return { dir, hash: dependencyHashFrom({ packageJson, lock, shrinkwrap, image: sandboxImage() }) };
}

export type SeedResult = { seeded: boolean; reason?: string };

/**
 * Скопировать слой в кэш проекта и записать маркер. `hash` — хэш проекта
 * (`dependencyLockHash`): совпадение с хэшем набора и есть условие «те же версии».
 */
export async function seedStarterLayer(options: {
  projectId: string;
  hash: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SeedResult> {
  const env = options.env ?? process.env;
  if (!dependencyCacheEnabled() || !starterLayerEnabled(env)) return { seeded: false, reason: "выключено" };
  const kit = await readStarterKit(env).catch(() => null);
  if (!kit) return { seeded: false, reason: "набор не задан" };
  if (kit.hash !== options.hash) return { seeded: false, reason: "версии проекта не совпадают с набором" };
  const source = path.join(starterLayerRoot(env), kit.hash, "node_modules");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) return { seeded: false, reason: "слой не собран" };

  const dest = dependencyCacheNodeModulesDir(options.projectId);
  const existing = await readdir(dest).catch(() => [] as string[]);
  // Незавершённая прошлая установка оставила маркер — его можно заменить. Всё остальное
  // значит, что у проекта уже есть своё дерево: не трогаем его.
  if (existing.some(name => name !== DEPENDENCY_CACHE_MARKER)) {
    return { seeded: false, reason: "у проекта уже есть node_modules" };
  }
  try {
    await rm(dest, { recursive: true, force: true });
    await ensureDependencyCacheLocal(options.projectId);
    await hardLinkTree(source, dest);
    await settleSeededTree(dest);
    const marker = path.join(dest, DEPENDENCY_CACHE_MARKER);
    await writeFile(marker, options.hash, "utf8");
    await chown(marker, SANDBOX_UID, SANDBOX_GID).catch(() => undefined);
    return { seeded: true };
  } catch (error) {
    // Частично скопированное дерево хуже отсутствия дерева: следующий запуск увидит файлы и
    // решит, что установка прошла. Убираем за собой и идём обычным путём.
    await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    return { seeded: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** `cp -al src/. dest/`: каталоги создаются свои, файлы — жёсткие ссылки на слой. */
async function hardLinkTree(source: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("cp", ["-al", source + "/.", dest + "/"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error("cp -al: код " + code + (stderr ? " — " + stderr.trim() : "")));
    });
  });
}

/**
 * Слой принадлежит root с файлами `0444`. После `cp -al` каталоги проекта созданы заново и
 * тоже root'ом с правами слоя: тогда проект (uid 1000) не смог бы удалить пакет и не смог бы
 * запустить `npm install` после изменения lock. Файлы остаются `0444` (общий inode не должен
 * писаться), а владельца и права каталогов приводим к обычному дереву проекта.
 */
async function settleSeededTree(root: string): Promise<void> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop() as string;
    await chown(dir, SANDBOX_UID, SANDBOX_GID).catch(() => undefined);
    await chmod(dir, 0o775).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      // Симлинки и файлы: смена владельца не меняет содержимое и права, поэтому слой цел.
      const info = await lstat(full).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      await chown(full, SANDBOX_UID, SANDBOX_GID).catch(() => undefined);
    }
  }
}
