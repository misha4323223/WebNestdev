import { createLimiter, positiveInt, type LimiterStats, type Slot } from "../concurrency.js";

/**
 * How many sandbox command containers this host starts at the same time.
 *
 * The memory of an agent run belongs to its containers, not to the run: every command
 * (`terminal.exec`, `npm.install`, `git.*`, the preview build) starts a fresh
 * `docker run --rm --memory SANDBOX_MEMORY` container that lives seconds, while a run lives
 * minutes and spends most of them waiting for the model. Bounding the *run* therefore bounded
 * the wrong thing: one user held the whole host while doing nothing but waiting on tokens, and
 * everybody else queued behind an idle conversation. This limiter bounds what actually holds
 * memory, so many conversations can be open at once and only the builds and installs serialize.
 *
 * The default is deliberately small: `--memory 1g` is a ceiling, not an allocation, and a
 * typical Vite build peaks around 300-500 MB, so two containers fit next to Postgres and the
 * server on a 2 GB VM and four or more fit on 8 GB. Raise it with the host, not with hope.
 */
const limiter = createLimiter(() => ({
  limit: positiveInt(process.env.SANDBOX_MAX_CONCURRENT, 2),
  queueLimit: positiveInt(process.env.SANDBOX_MAX_QUEUE, 32),
  waitTimeoutMs: positiveInt(process.env.SANDBOX_QUEUE_TIMEOUT_MS, 180_000),
  busyLabel: "Песочница",
}));

export function sandboxQueueStats(): LimiterStats {
  return limiter.stats();
}

/** Printed once at startup, next to the run limiter: what this host really runs at once. */
export function describeSandboxLimiter() {
  const stats = sandboxQueueStats();
  return "контейнеров песочницы параллельно: " + stats.limit + ", очередь: " + stats.queueLimit +
    ", ожидание до " + Math.round(positiveInt(process.env.SANDBOX_QUEUE_TIMEOUT_MS, 180_000) / 1000) + " с";
}

/**
 * Runs one sandbox command under that limit. A command that arrives while every place is busy
 * waits its turn instead of starting another container; the place is released on success, on
 * failure and on a timeout (the release lives in `finally`, because a leaked place would stop
 * the host from ever running another command).
 */
export async function withSandboxSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const slot: Slot = await limiter.acquire(signal);
  try {
    return await work();
  } finally {
    slot.release();
  }
}
