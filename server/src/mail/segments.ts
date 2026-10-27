import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { accountPlanFor } from "../billing/store.js";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";
import { getUserProfile } from "../account/profile-store.js";
import { getUserLastSeenAt, listUserIdentities } from "../auth/auth-store.js";
import type { MailRosterMember } from "./types.js";

/**
 * Сегменты рассылки.
 *
 * Сегмент — это правило, а не сохранённый список: получатели пересчитываются в момент отправки,
 * потому что за сутки между предпросмотром и рассылкой кто-то оплатил, кто-то ушёл с платформы.
 * Именно поэтому `send` требует числа-подтверждения: админка показывает посчитанное, и если оно
 * изменилось, рассылка не начинается, а переспрашивает заново.
 *
 * «Активность» здесь — вход в панель (отметка последней сессии), а не правка проекта: проект
 * может жить месяцами без захода владельца, а «спящий» сегмент нужен для писем о жизни
 * платформы, и таким людям писать не нужно.
 */

export type MailSegmentId = "active30" | "paying" | "free" | "inactive30" | "never" | "all";

export type MailSegment = { id: MailSegmentId; label: string; description: string };

export const MAIL_SEGMENTS: MailSegment[] = [
  { id: "active30", label: "Активные за 30 дней", description: "Заходили в панель за последние 30 дней" },
  { id: "paying", label: "На платном тарифе", description: "Тариф Pro или Team с живой подпиской" },
  { id: "free", label: "На бесплатном тарифе", description: "Тариф Free, включая закончившиеся подписки" },
  { id: "inactive30", label: "Спящие 30 дней", description: "Последний вход был раньше 30 дней назад" },
  { id: "never", label: "Ни разу не входили", description: "Аккаунт есть, входа в панель не было" },
  { id: "all", label: "Все аккаунты", description: "Все аккаунты платформы с пригодным адресом" },
];

export const MAIL_SEGMENT_IDS = MAIL_SEGMENTS.map(segment => segment.id);

export function isMailSegmentId(value: unknown): value is MailSegmentId {
  return typeof value === "string" && MAIL_SEGMENT_IDS.includes(value as MailSegmentId);
}

export function segmentById(id: MailSegmentId): MailSegment {
  return MAIL_SEGMENTS.find(segment => segment.id === id)!;
}

const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Роспись аккаунтов: одна запись на пользователя с почтой профиля, именем, тарифом и последним
 * входом. Один запрос на всю админку вместо запроса на строку — сегменты и предпросмотр считаются
 * по одной и той же росписи, поэтому числа между экранами не расходятся.
 */
export async function mailRoster(): Promise<MailRosterMember[]> {
  const rows = isYdbEnabled()
    ? await rosterFromSql()
    : await rosterFromFiles();
  // Тариф — единственная часть, которая не читается одним запросом: он вычисляется из подписки.
  // Параллельно и небольшими партиями, чтобы сотня аккаунтов не открыла сотню одновременных
  // запросов к базе.
  const withPlans: MailRosterMember[] = [];
  for (let index = 0; index < rows.length; index += 8) {
    const batch = rows.slice(index, index + 8);
    const plans = await Promise.all(batch.map(row => accountPlanFor(row.userId).catch(() => "free" as PlanId)));
    batch.forEach((row, offset) => withPlans.push({ ...row, plan: plans[offset] ?? "free" }));
  }
  return withPlans.sort((left, right) => left.userId.localeCompare(right.userId));
}

async function rosterFromSql(): Promise<Array<Omit<MailRosterMember, "plan">>> {
  const users = ydbQuery().identifier(getTable("users"));
  const profiles = ydbQuery().identifier(getTable("user_profiles"));
  const sessions = ydbQuery().identifier(getTable("sessions"));
  const [rows] = await ydbQuery()<Array<{
    id: string;
    email: string;
    profile_email: string | null;
    name: string | null;
    last_seen: string | null;
  }>>`
    SELECT u.id AS id,
           u.email AS email,
           COALESCE(p.email, '') AS profile_email,
           COALESCE(p.name, '') AS name,
           COALESCE(s.last_seen, '') AS last_seen
    FROM ${users} u
    LEFT JOIN ${profiles} p ON p.user_id = u.id
    LEFT JOIN (
      SELECT user_id, MAX(last_seen_at) AS last_seen
      FROM ${sessions}
      WHERE last_seen_at <> ''
      GROUP BY user_id
    ) s ON s.user_id = u.id
  `;
  return (rows ?? []).map(row => ({
    userId: row.id,
    // Почта для письма: сначала та, что человек ввёл сам при знакомстве, и только потом логин.
    // Логин может быть служебным адресом вида `79531814136@phone.webnestdev.local`, и такой
    // отсекается на следующем шаге — в очередь он не попадает.
    email: (row.profile_email || row.email || "").trim(),
    loginEmail: (row.email ?? "").trim(),
    name: (row.name ?? "").trim(),
    lastActiveAt: row.last_seen ? new Date(Date.parse(String(row.last_seen))).toISOString() : null,
  }));
}

async function rosterFromFiles(): Promise<Array<Omit<MailRosterMember, "plan">>> {
  const identities = await listUserIdentities();
  const roster: Array<Omit<MailRosterMember, "plan">> = [];
  for (const identity of identities) {
    const [profile, lastSeen] = await Promise.all([
      getUserProfile(identity.id).catch(() => null),
      getUserLastSeenAt(identity.id).catch(() => null),
    ]);
    roster.push({
      userId: identity.id,
      email: (profile?.email || identity.email || "").trim(),
      loginEmail: (identity.email ?? "").trim(),
      name: (profile?.name ?? "").trim(),
      lastActiveAt: lastSeen,
    });
  }
  return roster;
}

/** Отбор по сегменту: чистая функция от росписи, поэтому её проверяют тестом без хранилища. */
export function membersOf(roster: MailRosterMember[], segment: MailSegmentId, now = new Date()): MailRosterMember[] {
  const activeAfter = now.getTime() - ACTIVE_WINDOW_MS;
  return roster.filter(member => {
    const active = member.lastActiveAt ? Date.parse(member.lastActiveAt) : NaN;
    switch (segment) {
      case "active30":
        return Number.isFinite(active) && active >= activeAfter;
      case "inactive30":
        return Number.isFinite(active) && active < activeAfter;
      case "never":
        return !Number.isFinite(active);
      case "paying":
        return member.plan !== "free";
      case "free":
        return member.plan === "free";
      default:
        return true;
    }
  });
}

export function planLabel(plan: PlanId) {
  return PLAN_CATALOG[plan]?.name ?? plan;
}
