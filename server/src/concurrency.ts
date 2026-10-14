/**
 * A bounded queue for work that must not all run at once. An agent run and a Chromium check
 * each hold a container's worth of memory (about 1.5 GB together), and the host is usually
 * small, so the server decides how many run in parallel instead of letting every request
 * start immediately — an unbounded "run everything" is what turns a busy moment into an OOM
 * that takes the whole server down, Chromium included.
 *
 * A request that arrives while the limit is reached waits its turn instead of failing:
 * - the wait is bounded by `waitTimeoutMs`, so a stuck queue answers instead of hanging;
 * - the queue itself is bounded by `queueLimit`, so waiting requests cannot grow without limit;
 * - a wait ends at once when the caller's connection goes away (`signal`), which is what a
 *   closed tab or a pressed "stop" does.
 *
 * Options are read through a function, so the limits come from the environment at call time
 * (and a test can change them without restarting anything).
 */

export type LimiterOptions = { limit: number; queueLimit: number; waitTimeoutMs: number; busyLabel: string };
export type LimiterStats = { limit: number; active: number; queued: number; queueLimit: number };
export type Slot = { release: () => void };
export type Limiter = { acquire: (signal?: AbortSignal) => Promise<Slot>; stats: () => LimiterStats };

export class QueueFullError extends Error {
  readonly statusCode = 503;
  constructor(label: string, queueLimit: number) {
    super(label + " сейчас занят: очередь (" + queueLimit + ") заполнена, повторите запрос позже.");
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends Error {
  readonly statusCode = 503;
  constructor(label: string, waitTimeoutMs: number) {
    super(label + " сейчас занят: ожидание в очереди дольше " + Math.round(waitTimeoutMs / 1000) + " с, повторите запрос позже.");
    this.name = "QueueTimeoutError";
  }
}

/** The caller went away (socket closed). Nothing is left waiting and no slot is held. */
export class QueueAbortedError extends Error {
  constructor(label: string) {
    super(label + " отменён: соединение закрыто.");
    this.name = "QueueAbortedError";
  }
}

type Waiter = {
  resolve: (slot: Slot) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export function createLimiter(options: () => LimiterOptions): Limiter {
  let active = 0;
  const waiters: Waiter[] = [];

  function detach(waiter: Waiter) {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }

  function drop(waiter: Waiter) {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    detach(waiter);
  }

  /** One release per slot: a second call must not hand out capacity that does not exist. */
  function makeSlot(): Slot {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        active--;
        const next = waiters.shift();
        if (!next) return;
        // The freed capacity goes straight to the next waiter, so `active` stays where it is
        // and the waiting request never races with a newcomer for the free place.
        active++;
        detach(next);
        next.resolve(makeSlot());
      },
    };
  }

  function acquire(signal?: AbortSignal): Promise<Slot> {
    const { limit, queueLimit, waitTimeoutMs, busyLabel } = options();
    if (signal?.aborted) return Promise.reject(new QueueAbortedError(busyLabel));
    if (active < limit) {
      active++;
      return Promise.resolve(makeSlot());
    }
    if (waiters.length >= queueLimit) return Promise.reject(new QueueFullError(busyLabel, queueLimit));
    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, timer: undefined as unknown as NodeJS.Timeout };
      // Deliberately a live timer: a waiting request is unfinished work, so it may keep the
      // process alive. `unref()` here would drop the promise without an answer whenever the
      // queue wait happened to be the last thing the event loop was waiting for.
      waiter.timer = setTimeout(() => {
        drop(waiter);
        reject(new QueueTimeoutError(busyLabel, waitTimeoutMs));
      }, waitTimeoutMs);
      if (signal) {
        waiter.onAbort = () => {
          drop(waiter);
          reject(new QueueAbortedError(busyLabel));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  function stats(): LimiterStats {
    const { limit, queueLimit } = options();
    return { limit, active, queued: waiters.length, queueLimit };
  }

  return { acquire, stats };
}

/** A positive integer from the environment, falling back to the given default. */
export function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}
