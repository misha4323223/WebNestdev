import { unusableEmailReason } from "../mail/address.js";
import { sentSince } from "../mail/mail-store.js";
import { sendMail } from "../mail/mailer.js";
import type { MailDeps } from "../mail/smtp.js";
import { postboxConfig } from "../mail/postbox.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { countSupportMessagesSentSince, type SupportCategory } from "./support-store.js";

/**
 * Ответ человеку письмом от имени платформы.
 *
 * Транспорт — **SMTP платформы** (`mail/mailer.ts`), тот же, что у письма о новом обращении и у
 * уведомлений об оплате. Раньше ответ шёл через REST рассылки, и это была ошибка не в тексте
 * письма, а в выборе двери: пара `POSTBOX_KEY_ID` / `POSTBOX_SECRET` — это идентификатор и секрет
 * API-ключа сервисного аккаунта (логин и пароль SMTP), а не статический ключ доступа, которым
 * подписываются REST-запросы. Подпись таким ключом шлюз авторизации отвергает с `403 Forbidden` и
 * пустым телом — то есть рассылка и ответ падали вместе, хотя ключ верный и домен подтверждён.
 *
 * Квота осталась общей: у Postbox один суточный предел на аккаунт, и ответы считаются в него же
 * (`supportReplyQuota`). Считать их отдельно было бы удобнее в коде и хуже на живых людях.
 *
 * Отличие от рассылки одно: у ответа нет ссылки отписки. Отписка закрывает рекламные письма, а
 * ответ на обращение — не реклама; человек сам его ждёт. Зато есть Reply-To: письмо уходит от
 * сервисного ящика, и ответ на него должен попадать в поддержку, а не на адрес без ответа.
 */

export const REPLY_MIN_CHARS = 10;
export const REPLY_MAX_CHARS = 8_000;
export const REPLY_SUBJECT_MAX_CHARS = 300;

/** Адрес для ответа человека: настраивается в панели, по умолчанию — ящик поддержки платформы. */
export function supportReplyTo() {
  return getPlatformEnv("SUPPORT_REPLY_TO")?.trim() || "support@nestdev.ru";
}

/**
 * Куда отвечать: почта профиля важнее логина, потому что логин может быть служебным
 * (`79531814136@phone.webnestdev.local`) — такое письмо уйдёт отскоком. Проверка адреса живёт на
 * сервере, а не только в приложении: тело запроса можно прислать и мимо кнопки.
 */
export function supportReplyAddress(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && !unusableEmailReason(candidate)) return candidate.trim();
  }
  return null;
}

/** Тема по умолчанию: по ней человек понимает, на что именно ему ответили. */
export function supportReplySubject(ticket: { id: string; category: SupportCategory }) {
  return "Обращение " + ticket.id + ": " + (ticket.category === "bug" ? "ошибка" : "идея");
}

export type SupportReplySent = { messageId: string };

/**
 * Отправка ответа. `deps` — подмена SMTP-соединения в тестах: живого Postbox в CI нет, а проверять
 * нужно именно письмо (отправитель, Reply-To, тема, текст), а не факт вызова функции.
 *
 * Почта не настроена — отказ с именами переменных приходит из `sendMail`, а не общее «ошибка
 * отправки»: человек в админке должен видеть, что именно заполнить. Своей проверки здесь нет
 * намеренно — иначе отказ не попадал бы в `/api/health` (его записывает mailer).
 */
export async function sendSupportReply(
  input: { to: string; subject: string; text: string },
  deps: MailDeps = {},
): Promise<SupportReplySent> {
  const sent = await sendMail(
    { to: input.to, subject: input.subject, text: input.text, replyTo: supportReplyTo() },
    deps,
  );
  return { messageId: sent.messageId };
}

export type SupportReplyQuota = {
  perDay: number;
  sentToday: number;
  remainingToday: number;
  /** Отдельно видно, сколько из суточного предела занято рассылкой: ответы из-за неё и не уходят. */
  campaignSentToday: number;
  replySentToday: number;
};

/**
 * Суточный предел Postbox общий для рассылки и ответов. Считается по своим таблицам за последние
 * 24 часа — так же, как это делает очередь рассылки, а не «с полуночи»: у Postbox окно скользящее.
 */
export async function supportReplyQuota(now = new Date()): Promise<SupportReplyQuota> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [campaignSentToday, replySentToday] = await Promise.all([
    sentSince(since),
    countSupportMessagesSentSince(since.toISOString()),
  ]);
  const perDay = postboxConfig().dailyLimit;
  const sentToday = campaignSentToday + replySentToday;
  return { perDay, sentToday, remainingToday: Math.max(0, perDay - sentToday), campaignSentToday, replySentToday };
}
