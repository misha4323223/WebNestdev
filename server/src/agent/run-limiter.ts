import { createLimiter, positiveInt, type LimiterStats, type Slot } from "../concurrency.js";

/**
 * How many conversations this server runs at the same time.
 *
 * This is *not* the memory limit of the platform — the containers are, and they are bounded in
 * `sandbox/sandbox-limiter.ts`. A run spends most of its life waiting on the model, so holding
 * a place for the whole run made one user fill the host while doing nothing, with everyone else
 * queued behind an idle chat. What stays bounded here is the number of live interactions: every
 * run is an open stream to the provider plus its context, and hundreds of those are what a
 * provider rate limit or a monthly bill reacts to. The default is eight, which a single small
 * VM serves comfortably; raise it with the provider quota, not with the CPU count.
 *
 * The limit lives here rather than inside AgentRuntime because the run request — with its
 * queue position, its abort signal and its usage accounting — is assembled by the WebSocket
 * route, which is also the only way a run starts today.
 *
 * Two limits, not one: this host-wide limit and one run per account below. The second is what
 * stops a single user from taking every place with two tabs and two projects.
 */
const limiter = createLimiter(() => ({
  limit: positiveInt(process.env.AGENT_MAX_CONCURRENT_RUNS, 8),
  queueLimit: positiveInt(process.env.AGENT_MAX_QUEUE, 64),
  waitTimeoutMs: positiveInt(process.env.AGENT_QUEUE_TIMEOUT_MS, 300_000),
  busyLabel: "Сервер",
}));

export function acquireRunSlot(signal?: AbortSignal): Promise<Slot> {
  return limiter.acquire(signal);
}

/** The code the panel shows for a second run inside one account. */
export const ACCOUNT_BUSY_CODE = "RUN_ALREADY_ACTIVE";

/**
 * One account runs one agent at a time. The host limit below already bounds the whole server,
 * but it does not stop a single user from filling it: two tabs, two projects and one person
 * would hold every place while everyone else waits in the queue. The second request is refused
 * with a message instead, so the user knows their own run is still going.
 */
export class AccountBusyError extends Error {
  readonly code = ACCOUNT_BUSY_CODE;
  constructor() {
    super("Агент уже выполняется в этом аккаунте — дождитесь завершения или остановите текущий запуск.");
    this.name = "AccountBusyError";
  }
}

/** Account id -> runs it holds right now. Kept here, next to the host-wide limit. */
const runsByAccount = new Map<string, number>();

/** How many runs this account holds right now; the panel and the tests read it. */
export function accountRunCount(userId: string) {
  return runsByAccount.get(userId) ?? 0;
}

export type RunSlotOptions = {
  signal: AbortSignal;
  /** The account this run belongs to; a second run for it is refused while the first holds a place. */
  userId?: string;
  onQueued?: (waiting: number) => void;
};

/** One release per account place, so a double release cannot invent capacity. */
function takeAccountPlace(userId: string) {
  let released = false;
  runsByAccount.set(userId, accountRunCount(userId) + 1);
  return () => {
    if (released) return;
    released = true;
    const left = accountRunCount(userId) - 1;
    if (left > 0) runsByAccount.set(userId, left);
    else runsByAccount.delete(userId);
  };
}

/**
 * Runs one agent request under the host limit and the per-account one. A request that arrives
 * while the host limit is reached waits its turn, and `onQueued` is told where it stands so the
 * user sees a queue instead of a run that seems stuck.
 *
 * Every place is released on every exit — success, failure or cancellation. A leaked place is the
 * worst failure mode here: it would quietly stop the host (or the account) from ever running
 * another agent.
 */
export async function runWithRunSlot<T>(work: () => Promise<T>, options: RunSlotOptions): Promise<T> {
  const userId = options.userId;
  if (userId && accountRunCount(userId) >= 1) throw new AccountBusyError();
  // Taken before the wait, not after it: a queued request already belongs to the account, so its
  // second tab is refused right away instead of queueing behind itself for five minutes.
  const releaseAccount = userId ? takeAccountPlace(userId) : undefined;
  try {
    const stats = runQueueStats();
    if (stats.active >= stats.limit) options.onQueued?.(stats.queued + 1);
    const slot: Slot = await acquireRunSlot(options.signal);
    try {
      return await work();
    } finally {
      slot.release();
    }
  } finally {
    releaseAccount?.();
  }
}

export function runQueueStats(): LimiterStats {
  return limiter.stats();
}

/** Printed once at startup: what this host will actually run in parallel. */
export function describeRunLimiter() {
  const stats = runQueueStats();
  return "параллельных запусков агента: " + stats.limit + ", очередь: " + stats.queueLimit +
    ", ожидание до " + Math.round(positiveInt(process.env.AGENT_QUEUE_TIMEOUT_MS, 300_000) / 1000) + " с" +
    ", на аккаунт: 1 одновременно";
}
