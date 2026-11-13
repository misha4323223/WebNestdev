import { createHash } from "node:crypto";
import { chmod, chown, mkdir, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sandboxImage } from "../sandbox/config.js";
import { SANDBOX_GID, SANDBOX_UID } from "../sandbox/permissions.js";
import type { SandboxHost } from "../sandbox/host.js";

/**
 * Локальный кэш зависимостей предпросмотра.
 *
 * Исходники проекта живут на общем Gluster, а `node_modules` — на локальном диске каждой
 * ноды. Иначе `npm install` создаёт тысячи мелких файлов в реплицируемом каталоге: страдает
 * и установка, и Gluster, и вторая нода, которой эти файлы не нужны. В контейнер кэш
 * приходит отдельным mount'ом поверх `/workspace/node_modules`, поэтому проект видит
 * обычное дерево зависимостей, а общий storage — только исходники и `dist`.
 *
 * Путь по умолчанию — временный каталог: локальная разработка не должна требовать
 * подготовки `/var/lib`. В production путь задаётся `WEBNESTDEV_PREVIEW_CACHE_DIR` и
 * монтируется в сервер и Docker-брокер тем же абсолютным путём.
 */

export const DEPENDENCY_CACHE_MARKER = ".webnestdev-deps";
export const DEFAULT_DEPENDENCY_CACHE_TTL_DAYS = 30;

export function dependencyCacheEnabled(): boolean {
  const value = process.env.WEBNESTDEV_PREVIEW_CACHE?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

/** Путь, который видит процесс сервера/runner. */
export function dependencyCacheRoot(): string {
  const configured = process.env.WEBNESTDEV_PREVIEW_CACHE_DIR?.trim();
  return path.resolve(configured || path.join(os.tmpdir(), "webnestdev-preview-cache"));
}

/**
 * Путь, который видит Docker на этой ноде. В compose это тот же каталог; отдельная
 * переменная нужна, если сервер запущен в контейнере с другим mount path.
 */
export function dependencyCacheHostRoot(): string {
  const configured = process.env.WEBNESTDEV_PREVIEW_CACHE_HOST_DIR?.trim();
  return path.resolve(configured || dependencyCacheRoot());
}

function safeProjectId(projectId: string) {
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(projectId)) return projectId;
  // Внутренний id может быть не ASCII (локальный тест, старый проект). Каталог кэша не должен
  // зависеть от этого и тем более не должен принимать `/` или `..` как путь.
  return "id-" + createHash("sha256").update(projectId).digest("hex").slice(0, 32);
}

export function dependencyCacheProjectDir(projectId: string): string {
  return path.join(dependencyCacheRoot(), safeProjectId(projectId));
}

export function dependencyCacheHostDir(projectId: string): string {
  return path.join(dependencyCacheHostRoot(), safeProjectId(projectId));
}

export function dependencyCacheNodeModulesDir(projectId: string): string {
  return path.join(dependencyCacheProjectDir(projectId), "node_modules");
}

export function dependencyCacheMarkerPath(projectId: string): string {
  return path.join(dependencyCacheNodeModulesDir(projectId), DEPENDENCY_CACHE_MARKER);
}

/** `-v` для контейнера: локальный `node_modules` поверх общего каталога проекта. */
export function dependencyCacheMount(config: { projectId: string }): string {
  return dependencyCacheHostDir(config.projectId) + ":/workspace/node_modules";
}

/**
 * Каталог должен существовать до `docker run`, иначе Docker создаст его от root, а
 * `npm install` внутри контейнера (uid 1000) получит EACCES. Владелец — uid контейнера,
 * права — как у обычного каталога проекта.
 */
export async function ensureDependencyCacheLocal(projectId: string): Promise<string> {
  const dir = dependencyCacheProjectDir(projectId);
  const modules = dependencyCacheNodeModulesDir(projectId);
  await mkdir(modules, { recursive: true, mode: 0o775 });
  await chmod(dir, 0o775).catch(() => undefined);
  await chmod(modules, 0o775).catch(() => undefined);
  await chown(dir, SANDBOX_UID, SANDBOX_GID).catch(() => undefined);
  await chown(modules, SANDBOX_UID, SANDBOX_GID).catch(() => undefined);
  // Отметка использования: по ней уборщик отличает активный проект от забытого.
  const now = new Date();
  await utimes(dir, now, now).catch(() => undefined);
  return dir;
}

/** Создать кэш на ноде, где будет выполняться команда (локально или через runner). */
export async function ensureDependencyCache(host: SandboxHost, projectId: string): Promise<void> {
  if (!dependencyCacheEnabled()) return;
  if (host.ensureDependencyCache) {
    await host.ensureDependencyCache(projectId);
    return;
  }
  await ensureDependencyCacheLocal(projectId);
}

/**
 * Хэш контракта установки. Меняется `package.json`, lock-файл или образ Node — значит,
 * дерево нужно пересобрать. Маркер лежит внутри локального `node_modules`, поэтому после
 * очистки кэша он исчезает вместе с ним и установка происходит заново.
 */
export async function dependencyLockHash(root: string): Promise<string | null> {
  const packageJson = await readFile(path.join(root, "package.json"), "utf8").catch(() => null);
  if (packageJson === null) return null;
  const [lock, shrinkwrap] = await Promise.all([
    readFile(path.join(root, "package-lock.json"), "utf8").catch(() => ""),
    readFile(path.join(root, "npm-shrinkwrap.json"), "utf8").catch(() => ""),
  ]);
  const hash = createHash("sha256");
  hash.update(sandboxImage());
  hash.update("\0package.json\0");
  hash.update(packageJson);
  hash.update("\0package-lock.json\0");
  hash.update(lock);
  hash.update("\0npm-shrinkwrap.json\0");
  hash.update(shrinkwrap);
  return hash.digest("hex");
}

/**
 * Одна команда вместо «проверить с хоста и, может быть, поставить». Проверка и установка
 * происходят в контейнере, где смонтирован именно локальный кэш: API не пытается читать
 * `node_modules` на удалённой ноде, а устаревший маркер на Gluster не может обмануть запуск.
 */
export function dependencyEnsureCommand(hash: string): string {
  const marker = "node_modules/" + DEPENDENCY_CACHE_MARKER;
  return [
    'if [ -f "' + marker + '" ] && [ "$(cat "' + marker + '")" = "' + hash + '" ]; then',
    '  touch "' + marker + '"; echo "webnestdev-deps: cached"',
    "else",
    '  npm install --no-audit --no-fund && mkdir -p node_modules && printf "%s" "' + hash + '" > "' + marker + '" && echo "webnestdev-deps: installed"',
    "fi",
  ].join("\n");
}

export function dependencyCacheHit(output: string): boolean {
  return /\bwebnestdev-deps:\s*cached\b/.test(output);
}

export function dependencyCacheTtlMs(): number {
  const days = Number(process.env.WEBNESTDEV_PREVIEW_CACHE_TTL_DAYS ?? DEFAULT_DEPENDENCY_CACHE_TTL_DAYS);
  const safeDays = Number.isFinite(days) && days >= 1 ? Math.min(Math.round(days), 3650) : DEFAULT_DEPENDENCY_CACHE_TTL_DAYS;
  return safeDays * 24 * 60 * 60_000;
}

/**
 * Удаляет локальные кэши, к которым не обращались дольше TTL. Маркер обновляется при
 * каждом попадании, поэтому активный проект не потеряет `node_modules` из-за того, что
 * каталог был создан давно. Проекты без маркера (прерванная установка) удаляются по mtime
 * каталога.
 */
export async function cleanupDependencyCache(options: {
  root?: string;
  now?: number;
  ttlMs?: number;
} = {}): Promise<{ removed: number; scanned: number }> {
  const root = path.resolve(options.root ?? dependencyCacheRoot());
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? dependencyCacheTtlMs();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scanned++;
    const projectDir = path.join(root, entry.name);
    const marker = path.join(projectDir, "node_modules", DEPENDENCY_CACHE_MARKER);
    const markerInfo = await stat(marker).catch(() => null);
    const dirInfo = await stat(projectDir).catch(() => null);
    // Маркер обновляет установка, каталог — любая команда и запуск preview. Берём свежее из
    // двух: активный проект не должен потерять зависимости только потому, что lock не менялся.
    const lastUsed = Math.max(markerInfo?.mtimeMs ?? 0, dirInfo?.mtimeMs ?? 0);
    if (!lastUsed || now - lastUsed <= ttlMs) continue;
    try {
      await rm(projectDir, { recursive: true, force: true });
      removed++;
    } catch (error) {
      console.warn("[preview-cache] не удалось удалить " + projectDir + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return { removed, scanned };
}

/** Фоновый уборщик: один проход вскоре после старта и затем раз в `intervalMs`. */
export function startDependencyCacheCleanup(log: (message: string) => void = console.log): () => void {
  if (!dependencyCacheEnabled()) return () => undefined;
  const interval = Number(process.env.WEBNESTDEV_PREVIEW_CACHE_CLEANUP_INTERVAL_MS ?? 6 * 60 * 60_000);
  const every = Number.isFinite(interval) && interval >= 60_000 ? Math.round(interval) : 6 * 60 * 60_000;
  const run = () => {
    void cleanupDependencyCache()
      .then(result => {
        if (result.removed) log("[preview-cache] удалено устаревших кэшей: " + result.removed + " из " + result.scanned);
      })
      .catch(error => {
        console.warn("[preview-cache] уборка не удалась: " + (error instanceof Error ? error.message : String(error)));
      });
  };
  const startup = setTimeout(run, 30_000);
  startup.unref();
  const timer = setInterval(run, every);
  timer.unref();
  return () => {
    clearTimeout(startup);
    clearInterval(timer);
  };
}
