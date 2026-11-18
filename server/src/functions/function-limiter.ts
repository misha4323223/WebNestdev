/**
 * Ограничитель одновременных serverless-функций.
 *
 * Каждый вызов функции — отдельный контейнер с `--cpus 0.5` и памятью 128–1024 МБ.
 * Без ограничителя 50 сайтов с одновременными запросами дают столько же контейнеров:
 * Docker начинает душить API, static preview и PostgreSQL, а нехватка памяти заканчивается
 * OOM всей ноды. Поэтому дверь функций держит небольшой общий пул и отдельный пул на сайт:
 * один шумный сайт не занимает все слоты, а лишние запросы ждут в короткой очереди.
 *
 * Лимит — на процесс/ноду. NLB распределяет запросы между нодами, но общего счётчика между
 * ними нет: у каждой ноды свой пул. Это нормально, пока пул задан с запасом под остальные
 * сервисы; при выключенной ноде оставшаяся получает весь трафик и очередь, а не бесконечные
 * контейнеры.
 *
 * По умолчанию пул растёт вместе с CPU: 2 vCPU → 2 контейнера, 4 vCPU → 6, 8 vCPU → 12.
 * Контейнер резервирует до 0.5 CPU, поэтому на 4 CPU шесть функций занимают 3 vCPU и
 * оставляют 1 vCPU серверу, Caddy и PostgreSQL. Явные env-значения всегда важнее.
 */

import { availableParallelism } from "node:os";

export class FunctionCapacityError extends Error {
  readonly code = "FUNCTION_BUSY";
  readonly statusCode = 503;

  constructor(message = "Сейчас выполняется слишком много функций. Повторите запрос через секунду.") {
    super(message);
    this.name = "FunctionCapacityError";
  }
}

export type FunctionLimiterOptions = {
  /** Сколько контейнеров функций может выполняться одновременно на ноде. */
  maxConcurrent: number;
  /** Сколько из них может занять один сайт. */
  maxPerSite: number;
  /** Сколько запросов ждут слота; сверх этого — сразу 503. */
  maxQueue: number;
  /** Сколько ждать слота до 503. */
  waitMs: number;
};

type Waiter = {
  siteId: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  finished: boolean;
};

function positiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** 2 CPU оставляют текущие 2 слота; 4 CPU — 6; 8 CPU — 12. */
export function defaultFunctionConcurrency(cpus = availableParallelism()) {
  if (cpus <= 2) return 2;
  return Math.min(16, Math.max(3, Math.floor(cpus * 1.5)));
}

export function functionLimiterOptions(
  env: NodeJS.ProcessEnv = process.env,
  cpus = availableParallelism(),
): FunctionLimiterOptions {
  const maxConcurrent = positiveInt(env.FUNCTIONS_MAX_CONCURRENT, defaultFunctionConcurrency(cpus), 1, 64);
  return {
    maxConcurrent,
    // Один сайт не может занять весь пул: на 4 CPU это 2 слота из 6, на 8 CPU — 4 из 12.
    maxPerSite: Math.min(maxConcurrent, positiveInt(
      env.FUNCTIONS_MAX_CONCURRENT_PER_SITE,
      Math.max(1, Math.floor(maxConcurrent / 3)),
      1,
      64,
    )),
    maxQueue: positiveInt(env.FUNCTIONS_MAX_QUEUE, Math.max(16, maxConcurrent * 16), 0, 1_000),
    waitMs: positiveInt(env.FUNCTIONS_MAX_WAIT_MS, 5_000, 100, 120_000),
  };
}

export class FunctionLimiter {
  private active = 0;
  private activeBySite = new Map<string, number>();
  private queue: Waiter[] = [];

  constructor(private readonly options: FunctionLimiterOptions = functionLimiterOptions()) {}

  private canStart(siteId: string) {
    return this.active < this.options.maxConcurrent &&
      (this.activeBySite.get(siteId) ?? 0) < this.options.maxPerSite;
  }

  private start(siteId: string): () => void {
    this.active += 1;
    this.activeBySite.set(siteId, (this.activeBySite.get(siteId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const left = (this.activeBySite.get(siteId) ?? 1) - 1;
      if (left > 0) this.activeBySite.set(siteId, left);
      else this.activeBySite.delete(siteId);
      this.drain();
    };
  }

  /** Забирает слот; возвращённая функция обязана быть вызвана в `finally`. */
  async acquire(siteId: string): Promise<() => void> {
    if (this.canStart(siteId)) return this.start(siteId);
    if (this.queue.length >= this.options.maxQueue) throw new FunctionCapacityError();

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { siteId, resolve, reject, finished: false };
      waiter.timer = setTimeout(() => {
        if (waiter.finished) return;
        waiter.finished = true;
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new FunctionCapacityError(
          "Не дождались слота функции за " + Math.round(this.options.waitMs / 1000) + " с: сейчас выполняется слишком много запросов. Повторите позже.",
        ));
      }, this.options.waitMs);
      this.queue.push(waiter);
    });
  }

  private drain() {
    for (let index = 0; index < this.queue.length;) {
      const waiter = this.queue[index]!;
      if (waiter.finished || !this.canStart(waiter.siteId)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      waiter.finished = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(this.start(waiter.siteId));
    }
  }

  describe() {
    return "functions: одновременно " + this.options.maxConcurrent +
      ", на сайт " + this.options.maxPerSite +
      ", очередь " + this.options.maxQueue +
      ", ожидание " + Math.round(this.options.waitMs / 1000) + " с";
  }
}

export const functionLimiter = new FunctionLimiter();
