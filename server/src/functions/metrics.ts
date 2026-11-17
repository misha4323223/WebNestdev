/**
 * Лёгкие метрики двери функций.
 *
 * Это не трассировка и не биллинг: только счётчики в памяти процесса, чтобы ответить на
 * вопросы «сколько вызовов реально дошло до контейнера», «сколько ждали слот» и «сколько
 * времени занял ответ». Значения не переживают перезапуск и не растут вместе с числом
 * сайтов: хранятся только агрегаты, без путей, пользователей и тел запросов.
 *
 * Кеш только считается: `recordCacheHit`/`recordCacheMiss` заполняют `hits`, `misses` и
 * `hitRatio`, чтобы health и дашборд видели эффект без отдельного хранилища метрик.
 */

export type FunctionStatusCounts = {
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
};

export type FunctionCacheMetrics = {
  hits: number;
  misses: number;
  /** 0..1; null, пока не было ни одного обращения к кешу. */
  hitRatio: number | null;
};

export type FunctionMetricsSnapshot = {
  /** Момент сброса счётчиков (старт процесса или тест). */
  startedAt: string;
  requests: number;
  completed: number;
  inFlight: number;
  statuses: FunctionStatusCounts;
  capacityRejected: number;
  invokeFailed: number;
  jobEnqueueFailed: number;
  crashed: number;
  totalDurationMs: number;
  averageDurationMs: number | null;
  maxDurationMs: number;
  responseBytes: number;
  cache: FunctionCacheMetrics;
};

export type FinishFunctionRequest = (status: number, responseBytes?: number, now?: number) => void;

function statusKey(status: number): keyof FunctionStatusCounts {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  return "5xx";
}

export class FunctionMetrics {
  private startedAtMs = Date.now();
  private requests = 0;
  private completed = 0;
  private inFlight = 0;
  private statuses: FunctionStatusCounts = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  private capacityRejected = 0;
  private invokeFailed = 0;
  private jobEnqueueFailed = 0;
  private crashed = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private responseBytes = 0;
  private cacheHits = 0;
  private cacheMisses = 0;

  /** Начинает запрос; вернуть функцию нужно в `finally`, ровно один раз. */
  begin(now = Date.now()): FinishFunctionRequest {
    this.requests += 1;
    this.inFlight += 1;
    const startedAt = now;
    let finished = false;
    return (status, responseBytes = 0, finishedAt = Date.now()) => {
      if (finished) return;
      finished = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.completed += 1;
      this.statuses[statusKey(status)] += 1;
      const duration = Math.max(0, finishedAt - startedAt);
      this.totalDurationMs += duration;
      if (duration > this.maxDurationMs) this.maxDurationMs = duration;
      if (Number.isFinite(responseBytes) && responseBytes > 0) this.responseBytes += Math.round(responseBytes);
    };
  }

  recordCapacityRejection() {
    this.capacityRejected += 1;
  }

  recordInvokeFailure() {
    this.invokeFailed += 1;
  }

  recordJobEnqueueFailure() {
    this.jobEnqueueFailed += 1;
  }

  recordCrash() {
    this.crashed += 1;
  }

  recordCacheHit() {
    this.cacheHits += 1;
  }

  recordCacheMiss() {
    this.cacheMisses += 1;
  }

  snapshot(): FunctionMetricsSnapshot {
    const cacheTotal = this.cacheHits + this.cacheMisses;
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      requests: this.requests,
      completed: this.completed,
      inFlight: this.inFlight,
      statuses: { ...this.statuses },
      capacityRejected: this.capacityRejected,
      invokeFailed: this.invokeFailed,
      jobEnqueueFailed: this.jobEnqueueFailed,
      crashed: this.crashed,
      totalDurationMs: this.totalDurationMs,
      averageDurationMs: this.completed ? Math.round(this.totalDurationMs / this.completed) : null,
      maxDurationMs: this.maxDurationMs,
      responseBytes: this.responseBytes,
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRatio: cacheTotal ? Number((this.cacheHits / cacheTotal).toFixed(3)) : null,
      },
    };
  }

  reset(now = Date.now()) {
    this.startedAtMs = now;
    this.requests = 0;
    this.completed = 0;
    this.inFlight = 0;
    this.statuses = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    this.capacityRejected = 0;
    this.invokeFailed = 0;
    this.jobEnqueueFailed = 0;
    this.crashed = 0;
    this.totalDurationMs = 0;
    this.maxDurationMs = 0;
    this.responseBytes = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
}

export const functionMetrics = new FunctionMetrics();

export function functionMetricsSnapshot(): FunctionMetricsSnapshot {
  return functionMetrics.snapshot();
}

/** Тестам нужен чистый счётчик; production сбрасывает его только при старте процесса. */
export function resetFunctionMetricsForTests(now = Date.now()) {
  functionMetrics.reset(now);
}
