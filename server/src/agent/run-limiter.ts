import { QueueAbortedError, createLimiter, positiveInt, type LimiterStats, type Slot } from "../concurrency.js";

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

/**
 * Сколько ждать освобождения места аккаунта, прежде чем отказать.
 *
 * Отказ был мгновенным, и это ломало обычный сценарий: сообщение из очереди отправляют кнопкой
 * «Отправить сейчас» — панель закрывает сокет текущего запуска и сразу начинает новый. Сервер
 * видит новый запрос раньше, чем отменённый прогон успевает освободить своё место (он отпускает
 * его в `finally`, уже после того как клиент ушёл), и отвечает `RUN_ALREADY_ACTIVE` — то есть
 * собственное сообщение пользователя посчитано вторым агентом. Такой же просвет есть между
 * завершением прогона и следующей репликой из очереди. Небольшое ожидание закрывает его, а
 * правило остаётся прежним: одновременно у аккаунта идёт ровно один запуск, второй ждёт, а не
 * выполняется параллельно. `AGENT_ACCOUNT_WAIT_MS=0` возвращает немедленный отказ.
 */
export function accountWaitMs() {
  const raw = process.env.AGENT_ACCOUNT_WAIT_MS?.trim();
  if (!raw) return 5000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 5000;
}

/** Account id -> runs it holds right now. Kept here, next to the host-wide limit. */
const runsByAccount = new Map<string, number>();

/** Account id -> callbacks waiting for its place to free. */
const accountWaiters = new Map<string, Set<(freed: boolean) => void>>();

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
    if (left <= 0) releaseAccountWaiters(userId);
  };
}

/** Будит тех, кто ждёт место этого аккаунта: освободилось ровно сейчас. */
function releaseAccountWaiters(userId: string) {
  const waiters = accountWaiters.get(userId);
  if (!waiters) return;
  accountWaiters.delete(userId);
  for (const wake of [...waiters]) wake(true);
}

/**
 * Ждёт, пока аккаунт освободится: `true` — место свободно (или освободилось), `false` — время
 * вышло или соединение закрылось. Ожидание ограничено и не занимает места ни в очереди хоста, ни
 * в аккаунте, поэтому брошенная вкладка ничего не держит.
 */
function waitForAccountFree(userId: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (accountRunCount(userId) === 0) return Promise.resolve(true);
  if (timeoutMs <= 0 || signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    let settled = false;
    const waiters = accountWaiters.get(userId) ?? new Set<(freed: boolean) => void>();
    accountWaiters.set(userId, waiters);
    const finish = (freed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      waiters.delete(finish);
      if (!waiters.size) accountWaiters.delete(userId);
      resolve(freed && accountRunCount(userId) === 0);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.add(finish);
  });
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
  if (userId && accountRunCount(userId) >= 1) {
    // Сначала ждём: отменённый или только что завершённый прогон отпускает место через несколько
    // миллисекунд, и без этого ожидания собственное сообщение пользователя выглядело вторым агентом.
    await waitForAccountFree(userId, options.signal, accountWaitMs());
    // Соединение закрылось, пока мы ждали: запускать работу некому, и это не «аккаунт занят».
    if (options.signal.aborted) throw new QueueAbortedError("Запуск");
    if (accountRunCount(userId) >= 1) throw new AccountBusyError();
  }
  // Taken before the wait, not after it: a queued request already belongs to the account, so its
  // second tab is refused right away instead of queueing behind itself for five minutes.
  const releaseAccount = userId ? takeAccountPlace(userId) : undefined;
  // Место аккаунта отпускается и по обрыву соединения, а не только по концу работы: отменённый
  // прогон, застрявший в ожидании внешнего процесса (Docker, ответ провайдера), иначе держал бы
  // аккаунт занятым, и панель отвечала бы «Агент уже работает» при пустом экране. Место хоста при
  // этом не отпускается: работа может ещё держать контейнер, и общий предел обязан это видеть.
  const releaseOnAbort = releaseAccount
    ? () => releaseAccount()
    : undefined;
  if (releaseOnAbort) {
    if (options.signal.aborted) releaseOnAbort();
    else options.signal.addEventListener("abort", releaseOnAbort, { once: true });
  }
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
    if (releaseOnAbort) options.signal.removeEventListener("abort", releaseOnAbort);
    releaseAccount?.();
  }
}

export function runQueueStats(): LimiterStats {
  return limiter.stats();
}

/** Printed once at startup: what this host will actually run in parallel. */
export function describeRunLimiter() {
  const stats = runQueueStats();
  const accountWait = accountWaitMs();
  return "параллельных запусков агента: " + stats.limit + ", очередь: " + stats.queueLimit +
    ", ожидание до " + Math.round(positiveInt(process.env.AGENT_QUEUE_TIMEOUT_MS, 300_000) / 1000) + " с" +
    ", на аккаунт: 1 одновременно" +
    (accountWait > 0 ? ", ожидание места аккаунта до " + Math.round(accountWait / 1000) + " с" : ", место аккаунта не ждём");
}
