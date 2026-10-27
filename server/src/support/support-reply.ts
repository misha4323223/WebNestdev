import { unusableEmailReason } from "../mail/address.js";
import { sentSince } from "../mail/mail-store.js";
import { postboxConfig, sendPostboxEmail } from "../mail/postbox.js";
import { textToHtmlLinks } from "../mail/render.js";
import { getPlatformEnv } from "../platform/platform-env.js";
import { countSupportMessagesSentSince, type SupportCategory } from "./support-store.js";

/**
 * Ответ человеку письмом от имени платформы.
 *
 * Транспорт — тот же, что у рассылки (`mail/postbox.ts`, REST API v2): у Postbox одна квота на
 * аккаунт, и ответы поддержки считаются в неё же. Считать их отдельно было бы удобнее в коде и
 * хуже на живых людях: рассылка на 200 адресов выбирает суточный предел целиком, и следующий
 * ответ человеку получал бы 429 от Postbox вместо письма.
 *
 * Ключи второй раз настраивать не нужно: те же `POSTBOX_SENDER`, `POSTBOX_KEY_ID` / `POSTBOX_SECRET`
 * (или ключ сервисного аккаунта) и тот же `PLATFORM_URL`, что у рассылки.
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

export type SupportReplySent = { messageId: string; status: number };

export async function sendSupportReply(input: { to: string; subject: string; text: string }): Promise<SupportReplySent> {
  return sendPostboxEmail({
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: textToHtmlLinks(input.text),
    replyTo: supportReplyTo(),
  });
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
