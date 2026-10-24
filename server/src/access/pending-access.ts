import { randomUUID } from "node:crypto";

/**
 * Запрос доступа к внешнему сервису — тот же разговор с пользователем, что и запрос ключа,
 * но полей у него несколько (токен, Key ID, логин и пароль), а результат сохраняется не в
 * переменные проекта, а в зашифрованное хранилище интеграций. Поэтому у него отдельное
 * ожидание: агент останавливается на шаге, карточка в чате просит ровно те поля, которые
 * требует кабинет провайдера, а после сохранения инструмент возвращает только подтверждение.
 */

export type AccessKind = "cloud" | "domain" | "service" | "database" | "yandex";

export type AccessRequest = {
  id: string;
  projectId: string;
  userId: string;
  kind: AccessKind;
  providerId: string;
  createdAt: number;
  expiresAt: number;
};

export type AccessResolution =
  | { ok: true; account: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

type PendingEntry = AccessRequest & { settle: (resolution: AccessResolution) => void };

const pending = new Map<string, PendingEntry>();

/** Кабинет провайдера не вводят за пять минут: ключ ищут, создают и копируют дольше. */
export function accessRequestTimeoutMs() {
  const configured = Number(process.env.ACCESS_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : 600_000;
}

export function requestAccess(input: {
  projectId: string;
  userId: string;
  kind: AccessKind;
  providerId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): { request: AccessRequest; answer: Promise<AccessResolution> } {
  const id = randomUUID();
  const createdAt = Date.now();
  const timeoutMs = input.timeoutMs ?? accessRequestTimeoutMs();
  const expiresAt = createdAt + timeoutMs;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const answer = new Promise<AccessResolution>(resolve => {
    const settle = (resolution: AccessResolution) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.delete(id);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(resolution);
    };
    const onAbort = () => settle({ ok: false, error: "Запуск агента остановлен, доступ не сохранён" });
    timer = setTimeout(() => settle({ ok: false, error: "Пользователь не ввёл ключи за отведённое время" }), Math.max(1, timeoutMs));
    timer.unref?.();
    if (input.signal?.aborted) {
      settle({ ok: false, error: "Запуск агента остановлен, доступ не сохранён" });
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      id,
      projectId: input.projectId,
      userId: input.userId,
      kind: input.kind,
      providerId: input.providerId,
      createdAt,
      expiresAt,
      settle,
    });
  });

  return {
    request: { id, projectId: input.projectId, userId: input.userId, kind: input.kind, providerId: input.providerId, createdAt, expiresAt },
    answer,
  };
}

export function findAccessRequest(id: string): AccessRequest | null {
  const entry = pending.get(id);
  if (!entry) return null;
  return {
    id: entry.id,
    projectId: entry.projectId,
    userId: entry.userId,
    kind: entry.kind,
    providerId: entry.providerId,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

/** Поздно пришедшее значение не должно выглядеть сохранённым: false — окно уже закрыто. */
export function resolveAccessRequest(id: string, resolution: AccessResolution): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.settle(resolution);
  return true;
}
