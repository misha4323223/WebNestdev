import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { normalizeEmail } from "./address.js";
import type { MailCampaign, MailCampaignStatus, MailRecipient, MailRecipientStatus, MailSuppression, MailSuppressionReason } from "./types.js";

/**
 * Хранилище рассылок: кампании, их получатели и список отписок.
 *
 * Получатели лежат отдельными строками, а не списком внутри кампании, и это главное решение
 * здесь. Рассылка на 1 500 адресов идёт по секунде на письмо — почти полчаса, — и она обязана
 * пережить перезапуск сервера: после выкатки очередь продолжается с того письма, на котором
 * остановилась, а не начинается заново (иначе часть людей получит два письма). Состояние очереди
 * поэтому в базе, а не в памяти процесса.
 *
 * Два бэкенда, как и у остальных хранилищ платформы: PostgreSQL в production и JSON-файлы в
 * разработке. Файлы лежат в каталоге данных рядом с остальными данными сервера.
 */

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const mailDir = path.join(root, "mail");
const campaignsFile = path.join(mailDir, "campaigns.json");
const recipientsFile = path.join(mailDir, "recipients.json");
const suppressionsFile = path.join(mailDir, "suppressions.json");

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

type CampaignRow = {
  id: string; subject: string; body: string; segment_id: string; segment_label: string;
  recipients: number | string; sent: number | string; failed: number | string; skipped: number | string;
  status: string; stop_requested: boolean; error: string; created_by: string;
  created_at: string; started_at: string | null; finished_at: string | null;
};

type RecipientRow = {
  campaign_id: string; user_id: string | null; email: string; name: string; status: string;
  attempts: number | string; message_id: string; error: string; updated_at: string;
};

type SuppressionRow = { email: string; reason: string; note: string; created_at: string };

/** BIGINT в PostgreSQL возвращается строкой — числа приводим здесь, а не у каждого читателя. */
function num(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function campaignFromRow(row: CampaignRow): MailCampaign {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    segmentId: row.segment_id,
    segmentLabel: row.segment_label,
    recipients: num(row.recipients),
    sent: num(row.sent),
    failed: num(row.failed),
    skipped: num(row.skipped),
    status: row.status as MailCampaignStatus,
    stopRequested: Boolean(row.stop_requested),
    error: row.error ?? "",
    createdBy: row.created_by ?? "",
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

function recipientFromRow(row: RecipientRow): MailRecipient {
  return {
    campaignId: row.campaign_id,
    userId: row.user_id ?? "",
    email: row.email,
    name: row.name ?? "",
    status: row.status as MailRecipientStatus,
    attempts: num(row.attempts),
    messageId: row.message_id ?? "",
    error: row.error ?? "",
    updatedAt: row.updated_at,
  };
}

export type NewCampaign = {
  subject: string;
  body: string;
  segmentId: string;
  segmentLabel: string;
  createdBy: string;
  recipients: Array<{ userId: string; email: string; name: string }>;
};

/**
 * Кампания создаётся целиком: сначала получатели, потом сама запись со статусом `queued`.
 * Обратный порядок оставил бы кампанию, которая «идёт», но никому не пишет.
 */
export async function createCampaign(input: NewCampaign): Promise<MailCampaign> {
  const now = new Date().toISOString();
  const campaign: MailCampaign = {
    id: randomUUID(),
    subject: input.subject,
    body: input.body,
    segmentId: input.segmentId,
    segmentLabel: input.segmentLabel,
    recipients: input.recipients.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    status: "queued",
    stopRequested: false,
    error: "",
    createdBy: input.createdBy,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("mail_campaigns"))}
        (id,subject,body,segment_id,segment_label,recipients,sent,failed,skipped,status,stop_requested,error,created_by,created_at,started_at,finished_at)
      VALUES (${campaign.id},${campaign.subject},${campaign.body},${campaign.segmentId},${campaign.segmentLabel},${campaign.recipients},${campaign.sent},${campaign.failed},${campaign.skipped},${campaign.status},${campaign.stopRequested},${campaign.error},${campaign.createdBy},${campaign.createdAt},${campaign.startedAt},${campaign.finishedAt})
    `;
    for (const recipient of input.recipients) {
      await ydbQuery()`
        INSERT INTO ${ydbQuery().identifier(getTable("mail_recipients"))}
          (campaign_id,user_id,email,name,status,attempts,message_id,error,updated_at)
        VALUES (${campaign.id},${recipient.userId},${recipient.email},${recipient.name},${'queued'},${0},${''},${''},${now})
      `;
    }
    return campaign;
  }

  const campaigns = await readJson<MailCampaign[]>(campaignsFile, []);
  campaigns.push(campaign);
  await writeJsonAtomic(campaignsFile, campaigns);
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  for (const recipient of input.recipients) {
    recipients.push({ campaignId: campaign.id, userId: recipient.userId, email: recipient.email, name: recipient.name, status: "queued", attempts: 0, messageId: "", error: "", updatedAt: now });
  }
  await writeJsonAtomic(recipientsFile, recipients);
  return campaign;
}

export async function getCampaign(id: string): Promise<MailCampaign | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<CampaignRow[]>`
      SELECT * FROM ${ydbQuery().identifier(getTable("mail_campaigns"))} WHERE id = ${id} LIMIT 1
    `;
    const row = rows?.[0];
    return row ? campaignFromRow(row) : null;
  }
  const campaigns = await readJson<MailCampaign[]>(campaignsFile, []);
  return campaigns.find(campaign => campaign.id === id) ?? null;
}

/** Последние кампании: админке нужны свежие, а не все за год. */
export async function listCampaigns(limit = 10): Promise<MailCampaign[]> {
  const size = Math.max(1, Math.min(100, limit));
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<CampaignRow[]>`
      SELECT * FROM ${ydbQuery().identifier(getTable("mail_campaigns"))} ORDER BY created_at DESC LIMIT ${size}
    `;
    return (rows ?? []).map(campaignFromRow);
  }
  const campaigns = await readJson<MailCampaign[]>(campaignsFile, []);
  return [...campaigns].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, size);
}

async function saveCampaign(campaign: MailCampaign) {
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("mail_campaigns"))}
      SET recipients = ${campaign.recipients}, sent = ${campaign.sent}, failed = ${campaign.failed}, skipped = ${campaign.skipped},
          status = ${campaign.status}, stop_requested = ${campaign.stopRequested}, error = ${campaign.error},
          started_at = ${campaign.startedAt}, finished_at = ${campaign.finishedAt}
      WHERE id = ${campaign.id}
    `;
    return;
  }
  const campaigns = await readJson<MailCampaign[]>(campaignsFile, []);
  const index = campaigns.findIndex(item => item.id === campaign.id);
  if (index >= 0) campaigns[index] = campaign;
  await writeJsonAtomic(campaignsFile, campaigns);
}

export type CampaignPatch = Partial<Pick<MailCampaign, "status" | "error" | "startedAt" | "finishedAt" | "sent" | "failed" | "skipped" | "recipients" | "stopRequested">>;

/** Изменение кампании с сохранением остальных полей: очередь меняет только своё. */
export async function updateCampaign(id: string, patch: CampaignPatch): Promise<MailCampaign | null> {
  const campaign = await getCampaign(id);
  if (!campaign) return null;
  const next: MailCampaign = { ...campaign, ...patch };
  await saveCampaign(next);
  return next;
}

/** Просьба остановиться. Очередь увидит её на следующем письме и завершит кампанию как `stopped`. */
export async function requestCampaignStop(id: string): Promise<MailCampaign | null> {
  return updateCampaign(id, { stopRequested: true });
}

/**
 * Одно письмо, готовое к отправке: самое старое из очереди. Порядок — по времени обновления,
 * то есть по порядку постановки; повторные попытки упавшего письма уходят в конец, чтобы один
 * недоставленный адрес не задерживал остальных.
 */
export async function nextQueuedRecipient(campaignId: string): Promise<MailRecipient | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<RecipientRow[]>`
      SELECT * FROM ${ydbQuery().identifier(getTable("mail_recipients"))}
      WHERE campaign_id = ${campaignId} AND status = ${'queued'}
      ORDER BY updated_at ASC LIMIT 1
    `;
    const row = rows?.[0];
    return row ? recipientFromRow(row) : null;
  }
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  const pending = recipients
    .filter(recipient => recipient.campaignId === campaignId && recipient.status === "queued")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  return pending[0] ?? null;
}

export type RecipientPatch = { status: MailRecipientStatus; messageId?: string; error?: string; countAttempt?: boolean };

/** Отметка письма. Попытка считается здесь же: очередь не должна помнить это отдельно. */
export async function markRecipient(campaignId: string, email: string, patch: RecipientPatch): Promise<void> {
  const now = new Date().toISOString();
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("mail_recipients"))}
      SET status = ${patch.status},
          attempts = attempts + ${patch.countAttempt ? 1 : 0},
          message_id = ${patch.messageId ?? ""},
          error = ${(patch.error ?? "").slice(0, 500)},
          updated_at = ${now}
      WHERE campaign_id = ${campaignId} AND email = ${email}
    `;
    return;
  }
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  const index = recipients.findIndex(recipient => recipient.campaignId === campaignId && recipient.email === email);
  if (index < 0) return;
  recipients[index] = {
    ...recipients[index],
    status: patch.status,
    attempts: recipients[index].attempts + (patch.countAttempt ? 1 : 0),
    messageId: patch.messageId ?? "",
    error: (patch.error ?? "").slice(0, 500),
    updatedAt: now,
  };
  await writeJsonAtomic(recipientsFile, recipients);
}

export async function countRecipients(campaignId: string, status?: MailRecipientStatus): Promise<number> {
  if (isYdbEnabled()) {
    if (status) {
      const [rows] = await ydbQuery()<Array<{ total: number | string }>>`
        SELECT COUNT(*) AS total FROM ${ydbQuery().identifier(getTable("mail_recipients"))}
        WHERE campaign_id = ${campaignId} AND status = ${status}
      `;
      return num(rows?.[0]?.total);
    }
    const [rows] = await ydbQuery()<Array<{ total: number | string }>>`
      SELECT COUNT(*) AS total FROM ${ydbQuery().identifier(getTable("mail_recipients"))}
      WHERE campaign_id = ${campaignId}
    `;
    return num(rows?.[0]?.total);
  }
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  return recipients.filter(recipient => recipient.campaignId === campaignId && (!status || recipient.status === status)).length;
}

/** Итоговые числа кампании пересчитываются из строк: частичные счётчики в записи не нужны. */
export async function campaignCounters(campaignId: string) {
  const [sent, failed, skipped, queued] = await Promise.all([
    countRecipients(campaignId, "sent"),
    countRecipients(campaignId, "failed"),
    countRecipients(campaignId, "skipped"),
    countRecipients(campaignId, "queued"),
  ]);
  return { sent, failed, skipped, queued };
}

/** Сколько писем ушло за последние сутки — по своей таблице, как и требует предел Postbox. */
export async function sentSince(since: Date): Promise<number> {
  const iso = since.toISOString();
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ total: number | string }>>`
      SELECT COUNT(*) AS total FROM ${ydbQuery().identifier(getTable("mail_recipients"))}
      WHERE status = ${'sent'} AND updated_at >= ${iso}
    `;
    return num(rows?.[0]?.total);
  }
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  return recipients.filter(recipient => recipient.status === "sent" && recipient.updatedAt >= iso).length;
}

/** Сколько писем ушло с начала календарного месяца: у Postbox бесплатны первые 2 000 в месяц. */
export async function sentThisMonth(now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return sentSince(new Date(start));
}

export async function lastSentAt(): Promise<string | null> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ updated_at: string | null }>>`
      SELECT MAX(updated_at) AS updated_at FROM ${ydbQuery().identifier(getTable("mail_recipients"))} WHERE status = ${'sent'}
    `;
    return rows?.[0]?.updated_at ?? null;
  }
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  const sent = recipients.filter(recipient => recipient.status === "sent").map(recipient => recipient.updatedAt).sort();
  return sent.length ? sent[sent.length - 1] : null;
}

/**
 * После падения сервера письмо, помеченное `sending`, остаётся в этом состоянии навсегда: его
 * никто не отправит и никто не посчитает. При старте такие строки возвращаются в очередь —
 * повторная отправка одного письма менее неприятна, чем потерянное.
 */
export async function requeueStuck(): Promise<number> {
  const iso = new Date().toISOString();
  if (isYdbEnabled()) {
    const [stuck] = await ydbQuery()<Array<{ total: number | string }>>`
      SELECT COUNT(*) AS total FROM ${ydbQuery().identifier(getTable("mail_recipients"))} WHERE status = ${'sending'}
    `;
    const total = num(stuck?.[0]?.total);
    if (total === 0) return 0;
    await ydbQuery()`
      UPDATE ${ydbQuery().identifier(getTable("mail_recipients"))} SET status = ${'queued'}, updated_at = ${iso} WHERE status = ${'sending'}
    `;
    return total;
  }
  const recipients = await readJson<MailRecipient[]>(recipientsFile, []);
  let total = 0;
  const next = recipients.map(recipient => {
    if (recipient.status !== "sending") return recipient;
    total += 1;
    return { ...recipient, status: "queued" as MailRecipientStatus, updatedAt: iso };
  });
  if (total) await writeJsonAtomic(recipientsFile, next);
  return total;
}

/** Кампании, которые шли в момент остановки сервера: их очередь продолжается после старта. */
export async function campaignsInProgress(): Promise<MailCampaign[]> {
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<CampaignRow[]>`
      SELECT * FROM ${ydbQuery().identifier(getTable("mail_campaigns"))} WHERE status IN (${'queued'},${'sending'}) ORDER BY created_at ASC
    `;
    return (rows ?? []).map(campaignFromRow);
  }
  const campaigns = await readJson<MailCampaign[]>(campaignsFile, []);
  return campaigns.filter(campaign => campaign.status === "queued" || campaign.status === "sending");
}

export async function addSuppression(email: string, reason: MailSuppressionReason, note = ""): Promise<MailSuppression> {
  const record: MailSuppression = { email: normalizeEmail(email), reason, note, createdAt: new Date().toISOString() };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("mail_suppressions"))} (email,reason,note,created_at)
      VALUES (${record.email},${record.reason},${record.note},${record.createdAt})
    `;
    return record;
  }
  const list = await readJson<MailSuppression[]>(suppressionsFile, []);
  const index = list.findIndex(item => item.email === record.email);
  if (index >= 0) list[index] = record;
  else list.push(record);
  await writeJsonAtomic(suppressionsFile, list);
  return record;
}

export async function findSuppression(email: string): Promise<MailSuppression | null> {
  const normalized = normalizeEmail(email);
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<SuppressionRow[]>`
      SELECT * FROM ${ydbQuery().identifier(getTable("mail_suppressions"))} WHERE email = ${normalized} LIMIT 1
    `;
    const row = rows?.[0];
    return row ? { email: row.email, reason: row.reason as MailSuppressionReason, note: row.note ?? "", createdAt: row.created_at } : null;
  }
  const list = await readJson<MailSuppression[]>(suppressionsFile, []);
  return list.find(item => item.email === normalized) ?? null;
}

export async function listSuppressions(limit = 1000): Promise<MailSuppression[]> {
  const size = Math.max(1, Math.min(10_000, limit));
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<SuppressionRow[]>`
      SELECT * FROM ${ydbQuery().identifier(getTable("mail_suppressions"))} ORDER BY created_at DESC LIMIT ${size}
    `;
    return (rows ?? []).map(row => ({ email: row.email, reason: row.reason as MailSuppressionReason, note: row.note ?? "", createdAt: row.created_at }));
  }
  const list = await readJson<MailSuppression[]>(suppressionsFile, []);
  return [...list].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, size);
}

/** Карта отписок для предпросмотра и очереди: проверка нужна на каждый адрес, чтение — одно. */
export async function suppressionMap(): Promise<Map<string, MailSuppression>> {
  const list = await listSuppressions(10_000);
  return new Map(list.map(item => [item.email, item]));
}
