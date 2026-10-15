import { positiveInt } from "../concurrency.js";
import { ProviderHttpError } from "./provider-errors.js";

/**
 * Waiting out a provider that says "not now".
 *
 * A 429 or a 502 means the request never reached the model, so nothing about it has to change for
 * the next attempt — it just has to wait. Treating that as a failed run was the reason a long task
 * could not be finished: a free-tier router answers 429 often enough that "wait a minute and start
 * over" turned a quarter of an hour of work into an error message every couple of minutes.
 *
 * What is retried is deliberately narrow:
 * - `RATE_LIMIT` and `UNAVAILABLE` from the gateway, plus the network errors `fetch` itself throws
 *   (a dropped connection, a DNS hiccup, a connect timeout). All of them happen *before* the first
 *   byte of the answer, which is what makes a repeat safe;
 * - never a cancelled run (the user pressed stop or the tab closed) and never a refusal about the
 *   request itself (`AUTH`, a bad shape, a context overflow): those need a different fix, and
 *   step-runner.ts already has one for the last two.
 *
 * Waiting is bounded in both directions: each pause by `maxDelayMs`, and all of them together by
 * `budgetMs`. A gateway that keeps refusing after the whole budget is spent ends the run with a
 * sentence that says how long the agent already waited, not with the raw 429 it started from.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["RATE_LIMIT", "UNAVAILABLE"]);
/**
 * `fetch` reports a refused connection as `TypeError: fetch failed` with the real reason in `cause`,
 * so the message and the code names of the usual causes are both matched.
 */
const NETWORK_PATTERN = /fetch failed|socket hang up|other side closed|premature close|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|network error/i;

export type ProviderRetryDecision = { retryable: boolean; code?: string; retryAfterMs?: number };

/** Whether this failure means "try the same request again", and how long the gateway asked to wait. */
export function providerRetryDecision(error: unknown): ProviderRetryDecision {
  // Часть ответа уже ушла в панель (шаг упал посреди потока): повтор показал бы её второй раз.
  if (error && typeof error === "object" && (error as { partialStreamed?: unknown }).partialStreamed === true) return { retryable: false };
  if (error instanceof ProviderHttpError) {
    const decision: ProviderRetryDecision = { retryable: RETRYABLE_CODES.has(error.code), code: error.code };
    if (error.retryAfterMs) decision.retryAfterMs = error.retryAfterMs;
    return decision;
  }
  if (error instanceof Error) {
    // A cancelled run is not a provider problem: retrying would ignore the stop.
    if (error.name === "AbortError") return { retryable: false };
    if (NETWORK_PATTERN.test(error.message)) return { retryable: true, code: "NETWORK" };
  }
  return { retryable: false };
}

export type ProviderRetryPolicy = { attempts: number; baseDelayMs: number; maxDelayMs: number; budgetMs: number };

/**
 * How patient one step is with a provider. Five attempts spread over up to five minutes of waiting:
 * the routers this platform talks to ask for 10–60 seconds, so that covers a real rate-limit window
 * rather than the second between two immediate retries.
 */
export function providerRetryPolicy(): ProviderRetryPolicy {
  return {
    attempts: positiveInt(process.env.AGENT_PROVIDER_RETRIES, 5),
    baseDelayMs: positiveInt(process.env.AGENT_PROVIDER_RETRY_BASE_MS, 2_000),
    maxDelayMs: positiveInt(process.env.AGENT_PROVIDER_RETRY_MAX_MS, 60_000),
    budgetMs: positiveInt(process.env.AGENT_PROVIDER_RETRY_BUDGET_MS, 300_000),
  };
}

/**
 * The pause before attempt `attempt` (1 is the first retry). Doubling with jitter, and never less
 * than the gateway asked for: several runs refused in the same second must not come back together.
 */
export function providerRetryDelayMs(attempt: number, policy: ProviderRetryPolicy, retryAfterMs?: number, random: () => number = Math.random) {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential * (0.8 + 0.4 * random()));
  const wanted = retryAfterMs && retryAfterMs > 0 ? Math.max(jittered, retryAfterMs) : jittered;
  return Math.max(1, Math.min(policy.maxDelayMs, wanted));
}

/** A pause that ends at once when the run is aborted, so a stopped run never keeps holding a slot. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export type ProviderRetryOptions = ProviderRetryPolicy & {
  signal?: AbortSignal;
  /** Called before every pause: the panel shows that the run is waiting, not failing. */
  onWait?: (info: { attempt: number; attempts: number; waitMs: number; code?: string }) => void;
  /** Injectable for tests, which cannot spend real minutes on a rate limit. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

/** Русская форма счётного слова: 1 раз, 2 раза, 5 раз (и 11 раз, а не «11 раза»). */
export function pluralRu(count: number, one: string, few: string, many: string) {
  const tens = Math.abs(count) % 100;
  const units = tens % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

/** A pause that fits in a sentence: "45 с" or "4 мин". */
export function describeWait(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return seconds + " с";
  const minutes = Math.round(seconds / 60);
  return minutes + " мин";
}

function describeRetryExhausted(error: unknown, code: string | undefined, waitedMs: number, attempts: number) {
  const status = error instanceof ProviderHttpError ? " (HTTP " + error.status + ")" : "";
  const head = code === "RATE_LIMIT"
    ? "Провайдер ограничил частоту запросов" + status
    : code === "NETWORK"
      ? "Связь с провайдером не восстанавливается" + status
      : "Провайдер недоступен" + status;
  const retries = Math.max(1, attempts);
  return head + ". Агент подождал " + describeWait(waitedMs) + " и повторил запрос " + retries + " " + pluralRu(retries, "раз", "раза", "раз") +
    " — ограничение ещё держится. Это ограничение на стороне провайдера: подождите немного и нажмите «Продолжить», работа продолжится с этого же шага.";
}

/** The provider kept saying "not now" until the waiting budget ran out. */
export class ProviderRetryExhaustedError extends Error {
  readonly code: string;
  readonly waitedMs: number;
  readonly attempts: number;

  constructor(error: unknown, waitedMs: number, attempts: number) {
    const decision = providerRetryDecision(error);
    super(describeRetryExhausted(error, decision.code, waitedMs, attempts));
    this.name = "ProviderRetryExhaustedError";
    this.code = decision.code ?? "UNAVAILABLE";
    this.waitedMs = waitedMs;
    this.attempts = attempts;
  }
}

/** How long the first pause is, for the panel to say "жду и продолжаю" before it happens. */
export async function withProviderRetry<T>(run: () => Promise<T>, options: ProviderRetryOptions): Promise<T> {
  const sleep = options.sleep ?? sleepWithSignal;
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const decision = providerRetryDecision(error);
      if (!decision.retryable || options.signal?.aborted) throw error;
      const budgetLeft = options.budgetMs - waitedMs;
      if (attempt >= options.attempts || budgetLeft <= 0) throw new ProviderRetryExhaustedError(error, waitedMs, attempt - 1);
      const waitMs = Math.min(providerRetryDelayMs(attempt, options, decision.retryAfterMs, options.random), budgetLeft);
      options.onWait?.({ attempt: attempt + 1, attempts: options.attempts, waitMs, ...(decision.code ? { code: decision.code } : {}) });
      await sleep(waitMs, options.signal);
      waitedMs += waitMs;
      // A run stopped while it was waiting ends here, with the error it was waiting on.
      if (options.signal?.aborted) throw error;
    }
  }
}

/**
 * Printed once at startup next to the other limits: what a refused step will actually do.
 */
export function describeProviderRetry() {
  const policy = providerRetryPolicy();
  return "повторы при отказе провайдера: до " + policy.attempts + " попыток, пауза до " + Math.round(policy.maxDelayMs / 1000) +
    " с, всего ожидания до " + Math.round(policy.budgetMs / 60_000) + " мин";
}
