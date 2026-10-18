import { randomUUID } from "node:crypto";

/** Один вариант ответа: короткая подпись и необязательное пояснение под ней. */
export type QuestionOption = { label: string; description?: string };

/**
 * Что получает ожидающий инструмент. Выбор пользователя — это подписи вариантов, а не индексы:
 * индекс, перепутанный при обновлении окна, отправил бы модели не тот ответ. `custom` — текст,
 * который пользователь написал сам вместо готовых вариантов.
 */
export type QuestionResolution =
  | { ok: true; selected: string[]; custom?: string }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

export type PendingQuestion = {
  id: string;
  projectId: string;
  userId: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
  createdAt: number;
  expiresAt: number;
};

type PendingEntry = PendingQuestion & { settle: (resolution: QuestionResolution) => void };

const pending = new Map<string, PendingEntry>();

/**
 * Сколько сервер ждёт ответа на вопрос. Запуск в это время держит место в очереди, поэтому
 * ожидание ограничено так же, как у запроса ключа: человек может отойти, а следующий запуск
 * ждать не должен. Пять минут по умолчанию закрывают «сейчас прочитаю и выберу».
 */
export function questionTimeoutMs() {
  const configured = Number(process.env.QUESTION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 5_000 ? configured : 300_000;
}

/**
 * Регистрирует вопрос и возвращает обе стороны: то, что видит панель (текст, варианты, режим
 * выбора), и обещание ответа пользователя. Ответ приходит маршрутом
 * `/api/projects/:id/questions/:requestId/answer`, а не через сокет агента: сокет — про задачу,
 * а это отдельный короткий разговор с человеком.
 */
export function askUser(input: {
  projectId: string;
  userId: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): { question: PendingQuestion; answer: Promise<QuestionResolution> } {
  const id = randomUUID();
  const createdAt = Date.now();
  const timeoutMs = input.timeoutMs ?? questionTimeoutMs();
  const expiresAt = createdAt + timeoutMs;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const answer = new Promise<QuestionResolution>(resolve => {
    const settle = (resolution: QuestionResolution) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pending.delete(id);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(resolution);
    };
    const onAbort = () => settle({ ok: false, error: "Запуск агента остановлен, ответ не получен" });
    timer = setTimeout(() => settle({ ok: false, error: "Пользователь не ответил за отведённое время" }), Math.max(1, timeoutMs));
    timer.unref?.();
    if (input.signal?.aborted) {
      settle({ ok: false, error: "Запуск агента остановлен, ответ не получен" });
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      id,
      projectId: input.projectId,
      userId: input.userId,
      question: input.question,
      options: input.options,
      multiSelect: input.multiSelect,
      allowCustom: input.allowCustom,
      createdAt,
      expiresAt,
      settle,
    });
  });

  return {
    question: {
      id,
      projectId: input.projectId,
      userId: input.userId,
      question: input.question,
      options: input.options,
      multiSelect: input.multiSelect,
      allowCustom: input.allowCustom,
      createdAt,
      expiresAt,
    },
    answer,
  };
}

/** Вопрос, который ещё ждёт ответа: по нему маршрут проверяет, какие варианты допустимы. */
export function findPendingQuestion(id: string): PendingQuestion | null {
  const entry = pending.get(id);
  if (!entry) return null;
  return {
    id: entry.id,
    projectId: entry.projectId,
    userId: entry.userId,
    question: entry.question,
    options: entry.options,
    multiSelect: entry.multiSelect,
    allowCustom: entry.allowCustom,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

/**
 * Отвечает ожидающему инструменту. Возвращает false, когда вопрос уже истёк, был пропущен или
 * запуск завершился: иначе агент считал бы ответом то, что пользователь не выбирал.
 */
export function resolvePendingQuestion(id: string, resolution: QuestionResolution): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.settle(resolution);
  return true;
}
