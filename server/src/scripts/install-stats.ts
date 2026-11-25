/**
 * Отчёт по метрикам установки зависимостей.
 *
 *   npm run cache:stats            # файл метрик ноды по умолчанию
 *   npm run cache:stats -- /путь/installs.jsonl
 *
 * Нужен для решения «строить слой или хватит зеркала»: смотрим медиану и p90 времени
 * *первой* установки (запись `cached: false`), а не среднее по всем запускам — повторные
 * запуски с совпавшим маркером занимают миллисекунды и занижают картину.
 */
import { readFile } from "node:fs/promises";
import { installMetricsFile, type InstallMetric } from "../preview/install-metrics.js";

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

const seconds = (ms: number) => (ms / 1000).toFixed(1) + " с";

const file = process.argv[2] ?? installMetricsFile();
const raw = await readFile(file, "utf8").catch(() => null);
if (raw === null) {
  console.log("Метрик нет: " + file);
  console.log("Установка пишет их сама, если не задано WEBNESTDEV_INSTALL_METRICS=0.");
  process.exit(0);
}

const metrics = raw
  .split("\n")
  .filter(line => line.trim())
  .flatMap(line => {
    try {
      return [JSON.parse(line) as InstallMetric];
    } catch {
      return [];
    }
  });

type Group = { title: string; rows: InstallMetric[] };
const ok = metrics.filter(metric => metric.result === "ok");
const groups: Group[] = [
  { title: "все установки", rows: ok },
  { title: "первая установка (npm install)", rows: ok.filter(metric => !metric.cached) },
  { title: "из локального кэша (маркер)", rows: ok.filter(metric => metric.cached) },
  { title: "из предустановленного слоя", rows: ok.filter(metric => metric.layer) },
  { title: "через локальное зеркало реестра", rows: ok.filter(metric => metric.mirror) },
  { title: "неудачные", rows: metrics.filter(metric => metric.result === "failed") },
];

console.log("Файл: " + file);
console.log("Записей: " + metrics.length + "\n");
for (const group of groups) {
  if (group.rows.length === 0) continue;
  const durations = group.rows.map(metric => metric.durationMs);
  console.log(group.title + ": " + group.rows.length);
  console.log(
    "  медиана " + seconds(percentile(durations, 0.5)) +
      ", p90 " + seconds(percentile(durations, 0.9)) +
      ", максимум " + seconds(Math.max(...durations)),
  );
}
const first = ok.filter(metric => !metric.cached);
if (first.length) {
  const median = percentile(first.map(metric => metric.durationMs), 0.5);
  console.log("\nРешение по медиане первой установки:");
  console.log("  < 10 с — оптимизации не окупятся, ничего не меняем;");
  console.log("  10–45 с — достаточно локального зеркала реестра;");
  console.log("  > 45 с — зеркало и предустановленный слой.");
  console.log("  Сейчас: " + seconds(median) + " (" + (median > 45_000 ? "слой" : median > 10_000 ? "зеркало" : "не нужно") + ")");
}
