import { createLimiter, positiveInt, type LimiterStats, type Slot } from "../concurrency.js";

/**
 * How many Chromium instances run at the same time. The browser worker launches Chromium
 * *inside the server container* without a memory limit, so this is the cheapest protection
 * against the one failure that takes the whole platform down with it. Default one.
 */
const limiter = createLimiter(() => ({
  limit: positiveInt(process.env.BROWSER_MAX_CONCURRENT, 1),
  queueLimit: positiveInt(process.env.BROWSER_MAX_QUEUE, 8),
  waitTimeoutMs: positiveInt(process.env.BROWSER_QUEUE_TIMEOUT_MS, 60_000),
  busyLabel: "Браузерная проверка",
}));

/** What Chromium is doing right now, for /api/health and the startup line. */
export function browserQueueStats(): LimiterStats {
  return limiter.stats();
}

/** Holds a browser place for the whole check; the slot is released even when the check fails. */
export async function withBrowserSlot<T>(work: () => Promise<T>): Promise<T> {
  const slot: Slot = await limiter.acquire();
  try {
    return await work();
  } finally {
    slot.release();
  }
}
