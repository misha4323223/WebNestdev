import { randomUUID } from "node:crypto";

/**
 * Что получает ожидающий инструмент, когда пользователь ответил, отменил ввод, закрыл запуск
 * или не успел ввести значение. Сам секрет здесь не появляется никогда: ценность ответа — в том,
 * что значение уже записано в файл окружения сервером, а не в том, чтобы вернуть его модели.
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
  createdAt: number;
  expiresAt: number;
};

type PendingEntry = SecretRequest & { settle: (resolution: SecretResolution) => void };

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
 * Регистрирует запрос и возвращает обе стороны: то, что видит модель (имя переменной, файл,
 * причина — без значения), и обещание ответа пользователя. Ни один из этих объектов не несёт
 * само значение: его запишет маршрут `/api/projects/:id/secrets` напрямую в песочницу.
 */
export function requestSecret(input: {
  projectId: string;
  userId: string;
  variable: string;
  purpose: string;
  file: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): { request: SecretRequest; answer: Promise<SecretResolution> } {
  const id = randomUUID();
  const createdAt = Date.now();
  const timeoutMs = input.timeoutMs ?? secretRequestTimeoutMs();
  const expiresAt = createdAt + timeoutMs;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const answer = new Promise<SecretResolution>(resolve => {
    const settle = (resolution: SecretResolution) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.delete(id);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(resolution);
    };
    const onAbort = () => settle({ ok: false, error: "Запуск агента остановлен, ключ не сохранён" });
    timer = setTimeout(() => settle({ ok: false, error: "Пользователь не ввёл значение за отведённое время" }), Math.max(1, timeoutMs));
    timer.unref?.();
    if (input.signal?.aborted) {
      settle({ ok: false, error: "Запуск агента остановлен, ключ не сохранён" });
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      id,
      projectId: input.projectId,
      userId: input.userId,
      variable: input.variable,
      purpose: input.purpose,
      file: input.file,
      createdAt,
      expiresAt,
      settle,
    });
  });

  return {
    request: { id, projectId: input.projectId, userId: input.userId, variable: input.variable, purpose: input.purpose, file: input.file, createdAt, expiresAt },
    answer,
  };
}

/** Запрос, который ещё ждёт ввода: по нему маршрут проверяет, что значение пишется в тот файл. */
export function findSecretRequest(id: string): SecretRequest | null {
  const entry = pending.get(id);
  if (!entry) return null;
  return {
    id: entry.id,
    projectId: entry.projectId,
    userId: entry.userId,
    variable: entry.variable,
    purpose: entry.purpose,
    file: entry.file,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Отвечает ожидающему инструменту. Возвращает false, когда запрос уже истёк, был отменён или
 * запуск завершился: значение в этом случае не должно попасть в модель как «сохранено».
 */
export function resolveSecretRequest(id: string, resolution: SecretResolution): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.settle(resolution);
  return true;
}
