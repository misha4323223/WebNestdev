/**
 * Последняя неудача почты — то, что `/api/health` отдаёт полем `lastError`.
 *
 * Раньше отказ почты был виден только в логе контейнера и в тексте ответа тому, кто нажал кнопку:
 * снаружи «письма не уходят» неотличимо от «письма не настроены». Хранится последняя ошибка и её
 * вид (SMTP или REST), без значений ключей — только то, что ответил сервис.
 *
 * Запись переживает одну ошибку, а не историю: это состояние «что случилось последним», а не
 * журнал. Полный разбор остаётся в логе сервера и в переписке обращения.
 */

export type MailFailureKind = "smtp" | "postbox-rest";

export type MailFailure = {
  at: string;
  kind: MailFailureKind;
  /** Ответ сервиса или текст ошибки; значения ключей сюда не попадают. */
  message: string;
};

let last: MailFailure | null = null;

export function recordMailFailure(kind: MailFailureKind, error: unknown, now = new Date()): MailFailure {
  const message = error instanceof Error ? error.message : String(error);
  last = { at: now.toISOString(), kind, message: message.replace(/\s+/g, " ").trim().slice(0, 300) };
  return last;
}

export function lastMailFailure(): MailFailure | null {
  return last;
}

/** Тесты начинают с чистого состояния: иначе ошибка одного теста видна в следующем. */
export function resetMailHealth() {
  last = null;
}
