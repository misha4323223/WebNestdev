import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Потолок локального кэша зависимостей.
 *
 * Кэш живёт на локальном диске ноды (`preview/dependency-cache.ts`) и до сих пор ограничивался
 * только временем: TTL 30 дней и уборка раз в 6 часов. Времени недостаточно — сотня проектов с
 * `node_modules` по 200–500 МБ упирается в диск задолго до истечения TTL, а полный диск на ноде
 * означает остановку сборок, превью и PostgreSQL рядом. Поэтому у кэша появляется потолок размера:
 * при превышении первыми уходят самые давно использованные каталоги.
 *
 * Модуль намеренно не знает о проектах, базе и хостах: на вход каталог и предел, на выходе отчёт.
 * Так его можно вызвать из уборщика, из теста и вручную, не поднимая платформу.
 */

/** По умолчанию 6 ГиБ: на диске 48 ГБ это заметная, но не критичная доля; меняется переменной. */
export const DEFAULT_CACHE_MAX_BYTES = 6 * 1024 * 1024 * 1024;

/** `0` в `WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES` выключает потолок (остаётся только TTL). */
export function dependencyCacheMaxBytes(): number {
  const raw = process.env.WEBNESTDEV_PREVIEW_CACHE_MAX_BYTES?.trim();
  if (raw === "0") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CACHE_MAX_BYTES;
  return Math.floor(parsed);
}

/** Размер каталога по обычным файлам. Символические ссылки не разворачиваются. */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(target);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(target).catch(() => null);
    if (info) total += info.size;
  }
  return total;
}

export type CacheQuotaResult = {
  /** Сколько занимает кэш до уборки. */
  totalBytes: number;
  /** Сколько занимает после уборки. */
  remainingBytes: number;
  removed: number;
  freedBytes: number;
  /** Потолок, по которому считали; `0` — без потолка. */
  maxBytes: number;
  /** Уборка не понадобилась. */
  withinLimit: boolean;
};

/**
 * Убирает самые давно использованные каталоги, пока кэш не опустится под потолок.
 *
 * Запас `targetRatio` (0.9) — чтобы уборка не запускалась на каждом следующем мегабайте: после
 * прохода остаётся немного свободного места, и следующая установка зависимостей не превышает
 * предел сразу.
 *
 * `protectMs` защищает только что использованные каталоги: активная установка не должна лишиться
 * `node_modules` посреди работы, даже если кэш в этот момент больше потолка. Это защита от гонки,
 * а не способ обойти лимит — при следующем проходе такой каталог уже не защищён.
 */
export async function enforceDependencyCacheQuota(options: {
  root: string;
  maxBytes?: number;
  now?: number;
  protectMs?: number;
  targetRatio?: number;
}): Promise<CacheQuotaResult> {
  const root = path.resolve(options.root);
  const maxBytes = options.maxBytes ?? dependencyCacheMaxBytes();
  const now = options.now ?? Date.now();
  const protectMs = Math.max(0, options.protectMs ?? 60 * 60_000);
  const targetRatio = Math.min(0.95, Math.max(0.5, options.targetRatio ?? 0.9));

  if (maxBytes <= 0) {
    return { totalBytes: 0, remainingBytes: 0, removed: 0, freedBytes: 0, maxBytes: 0, withinLimit: true };
  }

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const projects: Array<{ dir: string; bytes: number; usedAt: number }> = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const info = await stat(dir).catch(() => null);
    if (!info) continue;
    const bytes = await directorySizeBytes(dir);
    totalBytes += bytes;
    projects.push({ dir, bytes, usedAt: info.mtimeMs });
  }
  if (totalBytes <= maxBytes) {
    return { totalBytes, remainingBytes: totalBytes, removed: 0, freedBytes: 0, maxBytes, withinLimit: true };
  }

  const target = Math.floor(maxBytes * targetRatio);
  projects.sort((left, right) => left.usedAt - right.usedAt);
  let remainingBytes = totalBytes;
  let removed = 0;
  for (const project of projects) {
    if (remainingBytes <= target) break;
    if (protectMs > 0 && now - project.usedAt < protectMs) continue;
    try {
      await rm(project.dir, { recursive: true, force: true });
      remainingBytes -= project.bytes;
      removed++;
    } catch (error) {
      console.warn("[preview-cache] не удалось убрать " + project.dir + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return {
    totalBytes,
    remainingBytes: Math.max(0, remainingBytes),
    removed,
    freedBytes: Math.max(0, totalBytes - remainingBytes),
    maxBytes,
    withinLimit: remainingBytes <= maxBytes,
  };
}
