import { createLimiter, positiveInt, type LimiterStats, type Slot } from "../concurrency.js";
import { accountPlanFor } from "../billing/store.js";
import { addSandboxSeconds, assertSandboxBudget, concurrentSandboxLimitFor } from "../account/resource-quota.js";

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
const hostLimiter = createLimiter(() => ({
  limit: positiveInt(process.env.SANDBOX_MAX_CONCURRENT, 2),
  queueLimit: positiveInt(process.env.SANDBOX_MAX_QUEUE, 32),
  waitTimeoutMs: positiveInt(process.env.SANDBOX_QUEUE_TIMEOUT_MS, 180_000),
  busyLabel: "Песочница",
}));

/**
 * Очередь одного аккаунта.
 *
 * Потолок хоста отвечает на вопрос «сколько контейнеров живёт на машине», но не на «кто их
 * занял»: один аккаунт с двумя параллельными сборками держал бы все места и остальные ждали бы
 * его. Поэтому у аккаунта своя очередь — не больше `concurrentSandbox` из тарифа. Лишняя команда
 * того же человека ждёт освобождения своего места и при этом **не занимает** место хоста, так что
 * другой пользователь проходит без задержки.
 *
 * Очередь, а не отказ: команды короткие, и ждать две секунды лучше, чем увидеть «занято» на
 * `git status`. Лимит `0` (переменная `SANDBOX_MAX_PER_USER=0`) отключает очередь аккаунта.
 */
type AccountGate = { limiter: ReturnType<typeof createLimiter>; limit: number };
const accountGates = new Map<string, AccountGate>();

function accountGate(userId: string, limit: number): AccountGate {
  const existing = accountGates.get(userId);
  if (existing) {
    // Предел читается на каждом acquire, поэтому смена тарифа подхватывается без пересоздания
    // очереди: пересоздание потеряло бы уже занятые места.
    existing.limit = limit;
    return existing;
  }
  let gate!: AccountGate;
  const limiter = createLimiter(() => ({
    limit: gate.limit,
    queueLimit: positiveInt(process.env.SANDBOX_MAX_QUEUE, 32),
    waitTimeoutMs: positiveInt(process.env.SANDBOX_QUEUE_TIMEOUT_MS, 180_000),
    busyLabel: "Песочница аккаунта",
  }));
  gate = { limiter, limit };
  accountGates.set(userId, gate);
  return gate;
}

/** Сколько аккаунт держит контейнеров прямо сейчас и сколько ему разрешено — для тестов и панели. */
export function accountSandboxStats(userId: string) {
  const gate = accountGates.get(userId);
  return { active: gate ? gate.limiter.stats().active : 0, limit: gate?.limit ?? 0 };
}

/** Для тестов: между проверками состояние очередей должно быть чистым. */
export function resetSandboxLimiters() {
  accountGates.clear();
}

export function sandboxQueueStats(): LimiterStats {
  return hostLimiter.stats();
}

/** Printed once at startup, next to the run limiter: what this host really runs at once. */
export function describeSandboxLimiter() {
  const stats = sandboxQueueStats();
  const perUser = process.env.SANDBOX_MAX_PER_USER?.trim();
  return "контейнеров песочницы параллельно: " + stats.limit + ", очередь: " + stats.queueLimit +
    ", ожидание до " + Math.round(positiveInt(process.env.SANDBOX_QUEUE_TIMEOUT_MS, 180_000) / 1000) + " с" +
    "; на аккаунт: " + (perUser === "0" ? "без ограничения" : perUser || "по тарифу (1–3)");
}

export type SandboxSlotOptions = { signal?: AbortSignal; userId?: string };

/**
 * Runs one sandbox command under the host limit and, when the owner is known, under the account's
 * own limit. Places are released on success, on failure and on a timeout (the release lives in
 * `finally`, because a leaked place would stop the host from ever running another command).
 *
 * Время контейнера списывается в квоту аккаунта после команды: это и есть «CPU-минуты» тарифа.
 * Проверка бюджета стоит до очереди — аккаунт с исчерпанным лимитом получает объяснение сразу, а
 * не ждёт три минуты в очереди, чтобы потом узнать то же самое.
 */
export async function withSandboxSlot<T>(
  work: () => Promise<T>,
  options: SandboxSlotOptions | AbortSignal = {},
): Promise<T> {
  // Старый вызов `withSandboxSlot(fn, signal)` остаётся рабочим: сигнал — единственное, что
  // передавали сюда до появления квот. Проверка по форме, а не `instanceof`: сигнал может прийти
  // из другого realm, и тогда `instanceof AbortSignal` дал бы ложь.
  const looksLikeSignal = typeof (options as AbortSignal)?.aborted === "boolean" &&
    typeof (options as AbortSignal)?.addEventListener === "function";
  const signal = looksLikeSignal ? (options as AbortSignal) : (options as SandboxSlotOptions).signal;
  const userId = looksLikeSignal ? undefined : (options as SandboxSlotOptions).userId;
  if (!userId) return runUnderHost(work, signal);

  const plan = await accountPlanFor(userId);
  await assertSandboxBudget(userId, plan);
  const limit = concurrentSandboxLimitFor(plan);
  const slot: Slot | null = limit > 0 ? await accountGate(userId, limit).limiter.acquire(signal) : null;
  try {
    return await runUnderHost(work, signal, userId);
  } finally {
    slot?.release();
  }
}

async function runUnderHost<T>(work: () => Promise<T>, signal?: AbortSignal, userId?: string): Promise<T> {
  const slot: Slot = await hostLimiter.acquire(signal);
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    slot.release();
    if (userId) {
      // Списание после освобождения места: сбой учёта не должен задерживать следующий контейнер,
      // поэтому ошибка только логируется — команда уже выполнена.
      await addSandboxSeconds(userId, Math.max(1, Math.round((Date.now() - startedAt) / 1000))).catch(error => {
        console.warn(
          "[quota] не удалось списать время песочницы: " + (error instanceof Error ? error.message : String(error)),
        );
      });
    }
  }
}
