import { normalizeEmail, unusableEmailReason } from "./address.js";
import { membersOf, type MailSegmentId } from "./segments.js";
import type { MailRosterMember, MailSuppression } from "./types.js";

/**
 * Получатели сегмента — одно место для предпросмотра, отправки и счётчика в шапке админки.
 *
 * Одни и те же правила должны применяться везде, иначе числа на экранах разойдутся: предпросмотр
 * покажет 1 500, а очередь отбросит часть адресов уже по ходу. Поэтому адреса фильтруются здесь:
 * служебные домены (`@phone.webnestdev.local` и подобные), отписки и повторы одного адреса.
 *
 * Отсев считается по причинам, а не одним числом: «1127 получателей, отброшено 47» без разбора
 * причин выглядит как ошибка платформы, а «из них 40 — служебные адреса» — как то, что и есть.
 *
 * Отдельная причина — отсутствие согласия на рекламные письма. Согласие даётся в знакомстве или
 * в настройках и хранится в профиле; без него адрес в кампанию не попадает, даже если почта
 * известна. Служебные письма (оплата, поддержка, безопасность) идут другим путём и согласия
 * не требуют.
 */

export type MailAudience = {
  segmentId: MailSegmentId;
  /** Кому реально уйдёт письмо: без отписок, служебных адресов и повторов. */
  members: MailRosterMember[];
  excluded: { unsubscribed: number; bounced: number; invalid: number; duplicate: number; noConsent: number };
  /** Первые отброшенные адреса с причиной — админке хватит пяти, чтобы понять картину. */
  skipped: Array<{ email: string; reason: string }>;
};

const SKIPPED_SAMPLES = 5;

export function audienceFor(
  segmentId: MailSegmentId,
  roster: MailRosterMember[],
  suppressions: Map<string, MailSuppression>,
): MailAudience {
  const excluded = { unsubscribed: 0, bounced: 0, invalid: 0, duplicate: 0, noConsent: 0 };
  const skipped: Array<{ email: string; reason: string }> = [];
  const members: MailRosterMember[] = [];
  const seen = new Set<string>();

  const note = (email: string, reason: string) => {
    if (skipped.length < SKIPPED_SAMPLES) skipped.push({ email, reason });
  };

  for (const member of membersOf(roster, segmentId)) {
    const email = normalizeEmail(member.email);
    const reason = unusableEmailReason(email);
    if (reason) {
      excluded.invalid += 1;
      note(member.email, reason);
      continue;
    }
    const suppression = suppressions.get(email);
    if (suppression) {
      if (suppression.reason === "unsubscribed") {
        excluded.unsubscribed += 1;
        note(member.email, "отписался от рассылки");
      } else if (suppression.reason === "invalid") {
        excluded.invalid += 1;
        note(member.email, "адрес признан нерабочим");
      } else {
        excluded.bounced += 1;
        note(member.email, suppression.reason === "complaint" ? "жалоба на письмо" : "письмо не доставлено (отскок)");
      }
      continue;
    }
    if (!member.productUpdates) {
      excluded.noConsent += 1;
      note(member.email, "нет согласия на рекламные письма");
      continue;
    }
    if (seen.has(email)) {
      excluded.duplicate += 1;
      note(member.email, "адрес встречается у двух аккаунтов");
      continue;
    }
    seen.add(email);
    members.push({ ...member, email });
  }

  return { segmentId, members, excluded, skipped };
}
