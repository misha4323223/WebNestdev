/**
 * Общий предохранитель двери функций.
 *
 * Лимит контейнеров (`functionLimiter`) ограничивает только одновременные вызовы. Но запрос
 * может застрять раньше: на чтении манифеста, проверке базы или ожидании слота, и таких
 * запросов может быть тысячи. Тогда память, сокеты и event loop кончаются раньше, чем
 * сработает лимит контейнеров.
 *
 * Здесь считается весь путь запроса. Сверх лимита запрос не висит десять секунд в depth-очереди,
 * а получает быстрый 503 с `Retry-After`: лучше честный отказ, чем нода, которая не отвечает
 * никому. Лимит — на процесс/ноду, как и пул функций: у каждой ноды свой запас.
 */

import { availableParallelism } from "node:os";

export class RequestGateError extends Error {
  readonly code = "API_BUSY";
  readonly statusCode = 503;

  constructor(message = "Сервер сейчас перегружен. Повторите запрос через секунду.") {
    super(message);
    this.name = "RequestGateError";
  }
}

export type RequestGateOptions = {
  /** Сколько запросов могут одновременно проходить через дверь на ноде. */
  maxInFlight: number;
  /** Сколько запросов ждут слота; сверх этого — сразу 503. */
  maxQueue: number;
  /** Сколько ждать слота до 503. */
  waitMs: number;
};

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  finished: boolean;
};

function positiveInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** 4 CPU → 256 одновременных запросов, 2 CPU → 128; это защита, а не обещание ёмкости. */
export function defaultMaxInFlight(cpus = availableParallelism()) {
  return Math.max(64, Math.min(1_024, cpus * 64));
}

export function requestGateOptions(
  env: NodeJS.ProcessEnv = process.env,
  cpus = availableParallelism(),
): RequestGateOptions {
  const maxInFlight = positiveInt(env.FUNCTIONS_MAX_IN_FLIGHT, defaultMaxInFlight(cpus), 1, 4_096);
  return {
    maxInFlight,
    maxQueue: positiveInt(env.FUNCTIONS_MAX_IN_FLIGHT_QUEUE, Math.max(128, maxInFlight * 2), 0, 8_192),
    waitMs: positiveInt(env.FUNCTIONS_MAX_IN_FLIGHT_WAIT_MS, 2_000, 100, 30_000),
  };
}

export class RequestGate {
  private active = 0;
  private queue: Waiter[] = [];

  constructor(private readonly options: RequestGateOptions = requestGateOptions()) {}

  private start(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  /** Забирает слот; возвращённую функцию обязательно вызывают в finally/onResponse. */
  async acquire(): Promise<() => void> {
    if (this.active < this.options.maxInFlight) return this.start();
    if (this.queue.length >= this.options.maxQueue) throw new RequestGateError();

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, finished: false };
      waiter.timer = setTimeout(() => {
        if (waiter.finished) return;
        waiter.finished = true;
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new RequestGateError("Не дождались свободного места на сервере. Повторите позже."));
      }, this.options.waitMs);
      this.queue.push(waiter);
    });
  }

  private drain() {
    while (this.queue.length && this.active < this.options.maxInFlight) {
      const waiter = this.queue.shift()!;
      if (waiter.finished) continue;
      waiter.finished = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(this.start());
    }
  }

  describe() {
    return "API: одновременно " + this.options.maxInFlight +
      ", очередь " + this.options.maxQueue +
      ", ожидание " + Math.round(this.options.waitMs / 1000) + " с";
  }
}

export const requestGate = new RequestGate();
