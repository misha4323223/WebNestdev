/**
 * Общий бюджет памяти контейнеров песочницы.
 *
 * Почему это отдельный учёт, а не ещё один счётчик мест. Места (`SANDBOX_MAX_CONCURRENT`)
 * ограничивают число одновременных команд, но ничего не говорят о сумме их `--memory`. Долгие
 * задания живут отдельно (`docker run -d`, до получаса) и раньше в этот предел не входили вовсе:
 * четыре задания по 1 ГБ могли стоять рядом с двумя командами на машине, где под песочницы
 * реально есть ~2.7 ГБ. Docker в таком случае не отказывает — он убивает процесс по OOM, и
 * жертвой становится не обязательно виновник.
 *
 * Поэтому и команды, и задания резервируют память из одного бюджета. Бюджет по умолчанию —
 * столько же, сколько дают места команд: `SANDBOX_MEMORY_MB` × `SANDBOX_MAX_CONCURRENT`
 * (1024 × 2 = 2048 МБ). Это не догадка о пике сборки, а потолок cgroup'ов, которые мы сами
 * выдаём: сумма потолков не может превышать измеренную доступную память. На node-1 и node-2
 * (замер 24.11.2026) 3886 МБ всего, 2.7–2.9 ГБ доступно, базовые процессы платформы держат
 * ~0.7 ГБ, так что 2048 МБ оставляют ~0.7 ГБ запаса на PostgreSQL, Caddy и рост API.
 *
 * Резервируется именно потолок, а не фактическое потребление: фактическое неизвестно заранее,
 * а превысить потолок контейнер не может. Отсюда следствие: с настройками по умолчанию рядом
 * живут два контейнера по 1 ГБ — то есть два долгих задания, или задание и команда, — а третье
 * ждёт освобождения памяти. Это и есть измеренное безопасное число, полученное из окружения,
 * а не вписанное в код.
 *
 * Ожидание, а не отказ: команда или задание ждёт до `SANDBOX_MEMORY_WAIT_MS` (120 с; у заданий
 * свой, более короткий срок), а потом получает объяснение. Одна резервация никогда не бывает
 * больше бюджета — иначе она не получила бы память никогда; такая резервация просто занимает
 * бюджет целиком и ждёт одна.
 */

import { positiveInt, QueueAbortedError, QueueTimeoutError } from "../concurrency.js";
import { sandboxMemoryMb } from "./config.js";

/** Сколько памяти контейнеров разрешено этому хосту. `SANDBOX_MEMORY_BUDGET_MB` переопределяет. */
export function sandboxMemoryBudgetMb(): number {
  const raw = Number(process.env.SANDBOX_MEMORY_BUDGET_MB);
  if (Number.isFinite(raw) && raw >= 256) return Math.floor(raw);
  return sandboxMemoryMb() * positiveInt(process.env.SANDBOX_MAX_CONCURRENT, 2);
}

/**
 * `--memory` из docker-аргументов в мегабайтах. Docker принимает `1024m`, `1g`, `512M` и просто
 * число байт; нам нужен потолок в МБ, чтобы сложить его с остальными.
 */
export function memoryLimitMb(value: string | undefined, fallbackMb: number): number {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return Math.max(1, Math.floor(fallbackMb));
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([bkmg])?b?$/.exec(text);
  if (!match) return Math.max(1, Math.floor(fallbackMb));
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return Math.max(1, Math.floor(fallbackMb));
  const unit = match[2] ?? "";
  const mb = unit === "g" ? amount * 1024 : unit === "k" ? amount / 1024 : unit === "b" ? amount / (1024 * 1024) : amount;
  return Math.max(1, Math.floor(mb));
}

export type SandboxMemoryStats = { limitMb: number; usedMb: number; waiting: number };

export type SandboxMemoryReservation = { release: () => void };

type Waiter = {
  sizeMb: number;
  resolve: (reservation: SandboxMemoryReservation) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

let usedMb = 0;
const waiters: Waiter[] = [];

export function sandboxMemoryStats(): SandboxMemoryStats {
  return { limitMb: sandboxMemoryBudgetMb(), usedMb, waiting: waiters.length };
}

/** Для тестов: между проверками бюджет должен быть свободен. */
export function resetSandboxMemoryBudget() {
  for (const waiter of waiters.splice(0)) {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
  usedMb = 0;
}

function detach(waiter: Waiter) {
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
}

function drop(waiter: Waiter) {
  const index = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  detach(waiter);
}

/** Резервация с однократным освобождением: двойной вызов не должен вернуть память дважды. */
function makeReservation(sizeMb: number): SandboxMemoryReservation {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      usedMb = Math.max(0, usedMb - sizeMb);
      handOutWaiting();
    },
  };
}

/**
 * Отдаёт память первому ожидающему, если она помещается. Строгий порядок: если первый не
 * помещается, второй не обгоняет его — иначе большая резервация могла бы ждать вечно.
 */
function handOutWaiting() {
  const budget = sandboxMemoryBudgetMb();
  while (waiters.length) {
    const head = waiters[0]!;
    if (usedMb + head.sizeMb > budget) return;
    waiters.shift();
    detach(head);
    usedMb += head.sizeMb;
    head.resolve(makeReservation(head.sizeMb));
  }
}

/**
 * Занимает память под контейнер. `waitMs` — сколько ждать освобождения; отмена приходит сигналом
 * (закрытая вкладка, нажатая кнопка «стоп»), чтобы ожидание не держало запуск.
 */
export function reserveSandboxMemory(
  requestedMb: number,
  options: { signal?: AbortSignal; waitMs?: number; label?: string } = {},
): Promise<SandboxMemoryReservation> {
  const budget = sandboxMemoryBudgetMb();
  const sizeMb = Math.min(budget, Math.max(1, Math.floor(requestedMb)));
  const label = options.label ?? "Память песочницы";
  if (options.signal?.aborted) return Promise.reject(new QueueAbortedError(label));
  if (!waiters.length && usedMb + sizeMb <= budget) {
    usedMb += sizeMb;
    return Promise.resolve(makeReservation(sizeMb));
  }
  const waitMs = options.waitMs ?? positiveInt(process.env.SANDBOX_MEMORY_WAIT_MS, 120_000);
  return new Promise<SandboxMemoryReservation>((resolve, reject) => {
    const waiter: Waiter = {
      sizeMb,
      resolve,
      reject,
      timer: setTimeout(() => {
        drop(waiter);
        reject(new QueueTimeoutError(label, waitMs));
      }, waitMs),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    waiter.timer.unref?.();
    if (options.signal) {
      waiter.onAbort = () => {
        drop(waiter);
        reject(new QueueAbortedError(label));
      };
      options.signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    waiters.push(waiter);
  });
}
