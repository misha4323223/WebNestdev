import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { dependencyCacheRoot } from "./dependency-cache.js";

/**
 * Замер установки зависимостей.
 *
 * Решение «строить зеркало и слой или нет» принимается по медиане времени первой установки,
 * а не по ощущениям: до этого модуля цифр не было нигде — в лог шёл только хвост вывода npm.
 * Здесь одна строка JSONL на установку: сколько шла, попала ли в локальный кэш, помог ли
 * слой, был ли включён реестр-зеркало.
 *
 * Файл лежит на локальном диске ноды, вне Gluster и **рядом** с корнем кэша проектов, а не
 * внутри него: уборщик кэша считает каждый каталог в `dependencyCacheRoot()` проектом и
 * удалил бы `metrics/` как сироту. Запись best-effort: метрика не имеет права уронить
 * установку, поэтому все ошибки глотаются.
 */

export type InstallMetric = {
  at: number;
  projectId: string;
  node?: string;
  image: string;
  result: "ok" | "failed";
  /** Установка не запускалась: маркер совпал или дерево пришло из слоя. */
  cached: boolean;
  /** Дерево пришло из предустановленного слоя (жёсткие ссылки). */
  layer: boolean;
  /** Установка шла через локальное зеркало реестра. */
  mirror: boolean;
  durationMs: number;
};

/** Потолок файла: разросшаяся метрика не должна съедать диск ноды. */
const MAX_BYTES = 4 * 1024 * 1024;

export function installMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.WEBNESTDEV_INSTALL_METRICS?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

/** Каталог метрик: рядом с кэшем проектов, но не внутри него (см. комментарий выше). */
export function installMetricsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WEBNESTDEV_INSTALL_METRICS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(dependencyCacheRoot()), "webnestdev-metrics");
}

export function installMetricsFile(root: string = installMetricsRoot()): string {
  return path.join(root, "installs.jsonl");
}

/**
 * Одна строка метрики. Ротация без потерь не нужна: это диагностика, а не аудит, поэтому
 * прошлый файл просто переименовывается и перезаписывается новым.
 */
export async function recordInstallMetric(
  metric: InstallMetric,
  options: { root?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  if (!installMetricsEnabled(options.env ?? process.env)) return;
  const file = installMetricsFile(options.root ?? installMetricsRoot(options.env ?? process.env));
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o775 });
    const info = await stat(file).catch(() => null);
    if (info && info.size > MAX_BYTES) await rename(file, file + ".1").catch(() => undefined);
    await appendFile(file, JSON.stringify(metric) + "\n", "utf8");
  } catch {
    // Диагностика не должна влиять на установку.
  }
}
