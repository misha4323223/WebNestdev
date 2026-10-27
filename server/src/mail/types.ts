import type { PlanId } from "../account/plans.js";

/** Состояния кампании: `queued` — ждёт отправки, `sending` — очередь идёт, дальше — итоговые. */
export type MailCampaignStatus = "queued" | "sending" | "sent" | "stopped" | "failed";

/** Состояние одного письма: `skipped` — не отправляем (отписка, дубль, служебный адрес). */
export type MailRecipientStatus = "queued" | "sending" | "sent" | "failed" | "skipped";

export type MailSuppressionReason = "unsubscribed" | "bounced" | "complaint" | "invalid";

export type MailCampaign = {
  id: string;
  subject: string;
  body: string;
  segmentId: string;
  segmentLabel: string;
  /** Сколько адресов поставили в очередь на момент начала. */
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  status: MailCampaignStatus;
  stopRequested: boolean;
  error: string;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type MailRecipient = {
  campaignId: string;
  /**
   * Аккаунт получателя. Нужен очереди: `{{plan}}` и `{{project}}` раскрываются в момент отправки,
   * а тариф и проект есть только у аккаунта — по адресу письма их не найти.
   */
  userId: string;
  email: string;
  name: string;
  status: MailRecipientStatus;
  attempts: number;
  messageId: string;
  error: string;
  updatedAt: string;
};

export type MailSuppression = {
  email: string;
  reason: MailSuppressionReason;
  note: string;
  createdAt: string;
};

export type MailRosterMember = {
  userId: string;
  /** Почта для письма: контактный адрес профиля, а при его отсутствии — логин. */
  email: string;
  /** Логин аккаунта: остаётся в базе, но может быть служебным адресом. */
  loginEmail: string;
  name: string;
  plan: PlanId;
  lastActiveAt: string | null;
};
