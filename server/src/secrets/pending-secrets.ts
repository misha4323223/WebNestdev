import { randomUUID } from "node:crypto";

/**
 * Что получает ожидающий инструмент, когда пользователь ответил, отменил ввод, закрыл запуск
 * или не успел ввести значение. Сам секрет здесь не появляется никогда: ценность ответа — в том,
 * что значение уже сохранено сервером в хранилище секретов проекта, а не в том, чтобы вернуть его модели.
 */
export type SecretResolution =
  | { ok: true; variable: string; file: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

export type SecretRequest = {
  id: string;
  projectId: string;
  userId: string;
  variable: string;
  purpose: string;
  file: string;
  /** Чат, в котором запрошен ключ: окно возвращается только в него. */
  conversationId?: string;
  createdAt: number;
  expiresAt: number;
};

/** Запрос, который ещё можно закрыть: `waiting` — живёт ли рядом инструмент, ждущий ответа. */
export type AvailableSecretRequest = SecretRequest & { waiting: boolean };

type PendingEntry = SecretRequest & { settle?: (resolution: SecretResolution) => void };

const pending = new Map<string, PendingEntry>();

/**
 * Сколько сервер ждёт ввода, прежде чем вернуть агенту «значение не введено». Запуск в это время
 * держит место в очереди, поэтому ожидание ограничено: человек может отойти, а другой запуск —
 * ждать. Пять минут по умолчанию закрывают «вставлю ключ из менеджера паролей» и не превращают
 * забытое окно в занятый слот на весь день.
 */
export function secretRequestTimeoutMs() {
  const configured = Number(process.env.SECRET_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : 300_000;
}

/**
 * Сколько запрос живёт после обрыва запуска — перезагрузки вкладки, потери сети, остановки.
 * Инструмент уже не ждёт, но поле ключа должно вернуться в чат: иначе человек видел запрос,
 * перезагрузил страницу и потерял единственную возможность сохранить значение. Тридцать минут
 * покрывают «вернулся к ноутбуку» и не копят брошенные запросы в памяти.
 */
export function secretRequestRecoveryMs() {
  const configured = Number(process.env.SECRET_REQUEST_RECOVERY_MS);
  return Number.isFinite(configured) && configured >= 60_000 ? configured : 1_800_000;
}

function publicRequest(entry: PendingEntry): SecretRequest {
  return {
    id: entry.id,
    projectId: entry.projectId,
    userId: entry.userId,
    variable: entry.variable,
    purpose: entry.purpose,
    file: entry.file,
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

/** Просроченный отсоединённый запрос убирается лениво: таймер мог не сработать при засыпании процесса. */
function dropExpired(entry: PendingEntry) {
  if (entry.settle) return false;
  if (entry.expiresAt > Date.now()) return false;
  pending.delete(entry.id);
  return true;
}

/**
 * Регистрирует запрос и возвращает обе стороны: то, что видит модель (имя переменной, файл,
 * причина — без значения), и обещание ответа пользователя. Ни один из этих объектов не несёт
 * само значение: его запишет маршрут `/api/projects/:id/secrets` напрямую в песочницу.
 *
 * Обрыв запуска не уничтожает запрос, а отсоединяет его: инструмент получает отказ, а само поле
 * остаётся доступным ещё `secretRequestRecoveryMs()`. Так перезагрузка страницы не отнимает у
 * человека уже показанное окно ключа.
 */
export function requestSecret(input: {
  projectId: string;
  userId: string;
  variable: string;
  purpose: string;
  file: string;
  conversationId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): { request: SecretRequest; answer: Promise<SecretResolution> } {
  const id = randomUUID();
  const createdAt = Date.now();
  const timeoutMs = input.timeoutMs ?? secretRequestTimeoutMs();
  const entry: PendingEntry = {
    id,
    projectId: input.projectId,
    userId: input.userId,
    variable: input.variable,
    purpose: input.purpose,
    file: input.file,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    createdAt,
    expiresAt: createdAt + timeoutMs,
  };
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const answer = new Promise<SecretResolution>(resolve => {
    const finish = (resolution: SecretResolution) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      resolve(resolution);
    };
    const detach = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      entry.settle = undefined;
      const recoveryMs = secretRequestRecoveryMs();
      entry.expiresAt = Date.now() + recoveryMs;
      // Отсоединённый запрос никого не держит: без таймера он жил бы до перезапуска сервера.
      const cleanup = setTimeout(() => pending.delete(id), recoveryMs);
      cleanup.unref?.();
      resolve({ ok: false, error: "Запуск агента остановлен, ключ не сохранён" });
    };
    const onAbort = () => detach();

    entry.settle = finish;
    timer = setTimeout(
      () => finish({ ok: false, error: "Пользователь не ввёл значение за отведённое время" }),
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    if (input.signal?.aborted) {
      finish({ ok: false, error: "Запуск агента остановлен, ключ не сохранён" });
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });

    // Новый запрос в том же чате заменяет старый отсоединённый: два окна для одного ключа
    // заставляли бы выбирать, какое из них настоящее.
    for (const [key, item] of pending) {
      if (
        key !== id &&
        !item.settle &&
        item.projectId === entry.projectId &&
        item.userId === entry.userId &&
        item.conversationId === entry.conversationId
      ) {
        pending.delete(key);
      }
    }
    pending.set(id, entry);
  });

  return { request: publicRequest(entry), answer };
}

/** Запрос, который ещё можно закрыть: живой или оставшийся после обрыва запуска. */
export function findSecretRequest(id: string): SecretRequest | null {
  const entry = pending.get(id);
  if (!entry) return null;
  if (dropExpired(entry)) return null;
  return publicRequest(entry);
}

/**
 * Отвечает ожидающему инструменту. Возвращает false, когда запрос уже истёк, был отменён, запуск
 * завершился или окно осталось после перезагрузки: значение в этом случае всё равно сохранено
 * маршрутом, но модели его подтверждать некому.
 */
export function resolveSecretRequest(id: string, resolution: SecretResolution): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  if (!entry.settle) {
    // Отсоединённый запрос закрывается сохранением или отказом. Ждущего инструмента уже нет,
    // поэтому доставкой это не считается.
    pending.delete(id);
    return false;
  }
  entry.settle(resolution);
  return true;
}

/**
 * Запросы, которые можно показать в чате после перезагрузки. Возвращаются только метаданные:
 * значение вводит человек, и до сохранения сервер его не знает.
 */
export function listSecretRequests(filter: {
  projectId: string;
  userId: string;
  conversationId?: string;
}): AvailableSecretRequest[] {
  const result: AvailableSecretRequest[] = [];
  for (const entry of pending.values()) {
    if (dropExpired(entry)) continue;
    if (entry.projectId !== filter.projectId || entry.userId !== filter.userId) continue;
    // Запрос принадлежит конкретному чату. Без фильтра показываем только запросы без чата:
    // иначе окно из одной переписки всплывало бы в другой.
    if (filter.conversationId ? entry.conversationId !== filter.conversationId : Boolean(entry.conversationId)) continue;
    result.push({ ...publicRequest(entry), waiting: Boolean(entry.settle) });
  }
  return result.sort((left, right) => right.createdAt - left.createdAt);
}
