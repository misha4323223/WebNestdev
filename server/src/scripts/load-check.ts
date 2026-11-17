/**
 * Небольшой нагрузочный прогон без внешних зависимостей.
 *
 * Нужен для этапа 8: сравнить p50/p95/p99, RPS и ошибки до и после кеша/выкатки. Скрипт
 * намеренно не пишет ничего в прод и не требует ключей: только читает указанный URL.
 *
 * Пример:
 *   npm run load:check -- --url https://example.ru/api/products --concurrency 20 --duration 30
 */

type Options = {
  url: string;
  concurrency: number;
  durationSeconds: number;
  timeoutMs: number;
  method: string;
  headers: Record<string, string>;
  json: boolean;
};

type Sample = { ok: boolean; status: number; ms: number; bytes: number; error?: string };

function positiveInt(value: string | undefined, name: string, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(name + " должен быть целым числом от 1 до " + max);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  const headers: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error("Неизвестный аргумент: " + arg);
    const [name, inline] = arg.slice(2).split("=", 2);
    if (name === "header") {
      const value = inline ?? argv[++index];
      if (!value) throw new Error("--header требует значение Name: value");
      const colon = value.indexOf(":");
      if (colon <= 0) throw new Error("--header требует формат Name: value");
      headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
      continue;
    }
    if (name === "json") {
      values.set(name, "1");
      continue;
    }
    const value = inline ?? argv[++index];
    if (!value) throw new Error("--" + name + " требует значение");
    values.set(name, value);
  }
  const rawUrl = values.get("url") ?? process.env.LOAD_TEST_URL ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Укажите --url http(s)://... или LOAD_TEST_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL должен быть http(s)");
  const method = (values.get("method") ?? "GET").toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error("Некорректный HTTP-метод");
  return {
    url: url.toString(),
    concurrency: positiveInt(values.get("concurrency"), "--concurrency", 10, 500),
    durationSeconds: positiveInt(values.get("duration"), "--duration", 15, 600),
    timeoutMs: positiveInt(values.get("timeout-ms"), "--timeout-ms", 10_000, 120_000),
    method,
    headers,
    json: values.has("json"),
  };
}

function percentile(sorted: number[], value: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1));
  return sorted[index];
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function oneRequest(options: Options): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body = await response.arrayBuffer();
    return {
      ok: response.status < 500,
      status: response.status,
      ms: performance.now() - started,
      bytes: body.byteLength,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - started,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const end = Date.now() + options.durationSeconds * 1000;
  const samples: Sample[] = [];
  let bytes = 0;

  async function worker() {
    while (Date.now() < end) {
      const sample = await oneRequest(options);
      samples.push(sample);
      bytes += sample.bytes;
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
  const elapsedSeconds = (performance.now() - started) / 1000;
  const latencies = samples.map(sample => sample.ms).sort((left, right) => left - right);
  const failures = samples.filter(sample => !sample.ok);
  const statuses: Record<string, number> = {};
  for (const sample of samples) statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1;
  const report = {
    url: options.url,
    method: options.method,
    concurrency: options.concurrency,
    durationSeconds: round(elapsedSeconds, 2),
    requests: samples.length,
    rps: round(samples.length / elapsedSeconds),
    p50Ms: round(percentile(latencies, 50)),
    p95Ms: round(percentile(latencies, 95)),
    p99Ms: round(percentile(latencies, 99)),
    maxMs: round(latencies.at(-1) ?? 0),
    errors: failures.length,
    errorRate: samples.length ? round((failures.length / samples.length) * 100, 2) : 0,
    statuses,
    bytes: bytes,
    firstError: failures[0]?.error ?? "",
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("URL: " + report.url);
  console.log("Метод: " + report.method + ", конкурентность: " + report.concurrency + ", время: " + report.durationSeconds + " с");
  console.log("Запросов: " + report.requests + " (" + report.rps + " RPS)");
  console.log("p50: " + report.p50Ms + " мс, p95: " + report.p95Ms + " мс, p99: " + report.p99Ms + " мс, max: " + report.maxMs + " мс");
  console.log("Ошибки: " + report.errors + " (" + report.errorRate + "%)");
  console.log("Статусы: " + JSON.stringify(report.statuses));
  if (report.firstError) console.log("Первая ошибка: " + report.firstError);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
