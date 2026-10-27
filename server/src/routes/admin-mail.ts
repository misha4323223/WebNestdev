import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordAudit } from "../security/audit-journal.js";
import { audienceFor, type MailAudience } from "../mail/audience.js";
import { maskEmail, unusableEmailReason } from "../mail/address.js";
import { checkMailDomain } from "../mail/domain.js";
import {
  createCampaign,
  getCampaign,
  lastSentAt,
  listCampaigns,
  listSuppressions,
  requestCampaignStop,
  sentSince,
  sentThisMonth,
  suppressionMap,
} from "../mail/mail-store.js";
import { POSTBOX_FREE_MONTHLY, postboxConfig, postboxStatus, sendPostboxEmail } from "../mail/postbox.js";
import { accountTags, mailQueueSnapshot, renderMail } from "../mail/queue.js";
import { unsubscribeFooter, unknownTags } from "../mail/render.js";
import { MAIL_SEGMENTS, isMailSegmentId, mailRoster, segmentById, type MailSegmentId } from "../mail/segments.js";

/**
 * Рассылка через Yandex Cloud Postbox — маршруты админки.
 *
 * Это не письма платформы (оплата, поддержка): здесь кампании по сегментам, у которых свои
 * требования — предпросмотр настоящего письма с раскрытыми подстановками, цена до отправки,
 * остановка на середине и честный счёт «сколько ушло за сутки».
 *
 * Ни один маршрут не отправляет письмо молча: `preview` и `overview` ничего не пишут, `test`
 * пишет только администратору, `send` требует числа получателей и сравнивает его с пересчитанным
 * (`confirm`). Между предпросмотром и отправкой проходят часы, за это время сегмент меняется, и
 * рассылка по устаревшему списку — это либо лишнее письмо человеку, либо пропущенный новый
 * аккаунт.
 *
 * Доступ — админ-токен (`Authorization: Bearer`), как у остальных /api/admin/*: cookie здесь не
 * используется, поэтому CSRF к этим маршрутам неприменим.
 */

const previewSchema = z.object({
  segmentId: z.string().min(1).max(40),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(100_000),
});

const testSchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(100_000),
  to: z.string().email().max(200).optional(),
});

const sendSchema = previewSchema.extend({
  confirm: z.coerce.number().int().min(0),
});

function segmentOf(value: string): MailSegmentId | null {
  return isMailSegmentId(value) ? value : null;
}

/** Роспись аккаунтов и отписки читаются один раз на запрос: сегменты считаются по одной картине. */
async function loadAudience(segmentId: MailSegmentId) {
  const [roster, suppressions] = await Promise.all([mailRoster(), suppressionMap()]);
  return audienceFor(segmentId, roster, suppressions);
}

async function loadAudiences(): Promise<Array<{ segment: (typeof MAIL_SEGMENTS)[number]; audience: MailAudience }>> {
  const [roster, suppressions] = await Promise.all([mailRoster(), suppressionMap()]);
  return MAIL_SEGMENTS.map(segment => ({ segment, audience: audienceFor(segment.id, roster, suppressions) }));
}

function excludedSummary(excluded: MailAudience["excluded"]) {
  const parts: string[] = [];
  if (excluded.invalid) parts.push("служебных и нерабочих адресов: " + excluded.invalid);
  if (excluded.unsubscribed) parts.push("отписавшихся: " + excluded.unsubscribed);
  if (excluded.bounced) parts.push("отскоков и жалоб: " + excluded.bounced);
  if (excluded.duplicate) parts.push("повторов адреса: " + excluded.duplicate);
  return parts.join(", ");
}

function costOf(recipients: number, per1000: number | null, freeLeft: number) {
  const billable = Math.max(0, recipients - freeLeft);
  const amount = per1000 === null ? null : Math.round((per1000 * billable) / 1000 * 100) / 100;
  return { amount, currency: "RUB", per1000, freeLeft, billable };
}

/** Предупреждения — то, что мешает рассылке сейчас или испортит её результат. */
function warningsFor(input: {
  configured: boolean;
  reason?: string;
  subject: string;
  body: string;
  audience?: MailAudience;
  quota?: { perDay: number; perSecond: number; sentToday: number; remainingToday: number };
  pricePer1000: number | null;
  domainHint: string;
  domainVerified: boolean;
  domainChecked: boolean;
}) {
  const warnings: string[] = [];
  if (!input.configured) warnings.push(input.reason ?? "Postbox не настроен: задайте ключ и адрес отправителя.");
  if (input.domainChecked && !input.domainVerified) warnings.push(input.domainHint);
  if (!input.domainChecked && input.domainHint) warnings.push(input.domainHint);
  if (!input.pricePer1000 && input.pricePer1000 !== 0) {
    warnings.push("Цена за 1 000 писем не задана (POSTBOX_PRICE_PER_1000): стоимость не рассчитана — Postbox тарифицирует отправку, и цену стоит указать хотя бы для порядка.");
  }
  for (const tag of [...unknownTags(input.subject), ...unknownTags(input.body)]) {
    warnings.push("Тег {{" + tag + "}} останется в письме как есть: платформа раскрывает {{name}}, {{email}}, {{project}}, {{plan}}, {{unsubscribe}}.");
  }
  if (!input.body.includes("{{unsubscribe}}")) {
    warnings.push("В письме нет {{unsubscribe}} — ссылка отписки будет дописана в конец автоматически.");
  }
  if (input.audience) {
    const excluded = excludedSummary(input.audience.excluded);
    if (excluded) warnings.push("Из сегмента выброшено — " + excluded + ".");
    if (!input.audience.members.length) warnings.push("В сегменте нет ни одного адреса, готового к отправке.");
  }
  if (input.audience && input.quota && input.audience.members.length > input.quota.remainingToday) {
    const minutes = Math.ceil(input.audience.members.length / Math.max(1, input.quota.perSecond) / 60);
    warnings.push(
      "Писем больше, чем осталось на сегодня (" + input.audience.members.length + " из " + input.quota.remainingToday +
      "): очередь остановится на пределе и продолжит завтра сама. При " + input.quota.perSecond + " письме в секунду вся рассылка займёт около " + minutes + " мин.",
    );
  }
  return warnings;
}

export async function registerAdminMailRoutes(app: FastifyInstance) {
  /** Материалы рассылки: сегменты с числами, последние кампании, квота и состояние домена. */
  app.get("/api/admin/mail/overview", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    applyNoStoreToReply(reply);

    const config = postboxConfig();
    const status = await postboxStatus(config);
    const [segments, campaigns, sentToday, sentMonth, lastCampaignSentAt, suppressions, queue] = await Promise.all([
      loadAudiences(),
      listCampaigns(10),
      sentSince(new Date(Date.now() - 24 * 60 * 60 * 1000)),
      sentThisMonth(),
      lastSentAt(),
      listSuppressions(10_000),
      mailQueueSnapshot(),
    ]);
    const domain = config.sender
      ? await checkMailDomain(config.sender, config.dkimSelectors)
      : null;
    const quota = {
      perDay: config.dailyLimit,
      perSecond: config.perSecond,
      sentToday,
      remainingToday: Math.max(0, config.dailyLimit - sentToday),
    };

    return {
      generatedAt: new Date().toISOString(),
      configured: status.configured,
      ...(status.reason ? { reason: status.reason } : {}),
      provider: "postbox",
      sender: config.sender,
      fromName: config.fromName ?? "",
      auth: status.configured ? { kind: status.authKind ?? "", source: status.authSource ?? "" } : null,
      domainVerified: Boolean(domain?.verified),
      domain,
      quota,
      sentThisMonth: sentMonth,
      freeThisMonth: Math.max(0, POSTBOX_FREE_MONTHLY - sentMonth),
      pricePer1000: config.pricePer1000,
      segments: segments.map(({ segment, audience }) => ({
        id: segment.id,
        label: segment.label,
        description: segment.description,
        recipients: audience.members.length,
        excluded: audience.excluded,
      })),
      campaigns,
      lastSentAt: lastCampaignSentAt,
      suppressions: { total: suppressions.length, recent: suppressions.slice(0, 20) },
      queue,
      warnings: warningsFor({
        configured: status.configured,
        reason: status.reason,
        subject: "",
        body: "{{unsubscribe}}",
        quota,
        pricePer1000: config.pricePer1000,
        domainHint: domain?.hint ?? "Адрес отправителя не задан (POSTBOX_SENDER).",
        domainVerified: Boolean(domain?.verified),
        domainChecked: Boolean(domain?.checked),
      }),
    };
  });

  /** Предпросмотр: сколько получателей, сколько отброшено, как выглядит письмо и сколько стоит. */
  app.post("/api/admin/mail/preview", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    applyNoStoreToReply(reply);

    const body = previewSchema.parse(request.body);
    const segmentId = segmentOf(body.segmentId);
    if (!segmentId) {
      return reply.code(400).send({ error: "Неизвестный сегмент: " + body.segmentId + ". Доступны: " + MAIL_SEGMENTS.map(item => item.id).join(", ") });
    }

    const config = postboxConfig();
    const status = await postboxStatus(config);
    const [audience, sentToday, sentMonth] = await Promise.all([
      loadAudience(segmentId),
      sentSince(new Date(Date.now() - 24 * 60 * 60 * 1000)),
      sentThisMonth(),
    ]);
    const domain = config.sender ? await checkMailDomain(config.sender, config.dkimSelectors) : null;
    const quota = {
      perDay: config.dailyLimit,
      perSecond: config.perSecond,
      sentToday,
      remainingToday: Math.max(0, config.dailyLimit - sentToday),
    };
    const freeLeft = Math.max(0, POSTBOX_FREE_MONTHLY - sentMonth);

    // Живые примеры: три настоящих письма с раскрытыми тегами — так видно и «Здравствуйте, —», и
    // «Проект: проект», до отправки.
    const sample = [];
    for (const member of audience.members.slice(0, 3)) {
      const tags = await accountTags(member.userId, config.platformUrl);
      const mail = renderMail({ subject: body.subject, body: body.body }, member, tags);
      sample.push({ email: member.email, name: member.name, subject: mail.subject, body: mail.text });
    }

    return {
      generatedAt: new Date().toISOString(),
      segmentId,
      segmentLabel: segmentById(segmentId).label,
      recipients: audience.members.length,
      excluded: audience.excluded,
      skipped: audience.skipped,
      sample,
      cost: costOf(audience.members.length, config.pricePer1000, freeLeft),
      quota,
      configured: status.configured,
      ...(status.reason ? { reason: status.reason } : {}),
      domainVerified: Boolean(domain?.verified),
      footer: unsubscribeFooter(config.platformUrl + "/unsubscribe?t=<подпись адреса>"),
      warnings: warningsFor({
        configured: status.configured,
        reason: status.reason,
        subject: body.subject,
        body: body.body,
        audience,
        quota,
        pricePer1000: config.pricePer1000,
        domainHint: domain?.hint ?? "Адрес отправителя не задан (POSTBOX_SENDER).",
        domainVerified: Boolean(domain?.verified),
        domainChecked: Boolean(domain?.checked),
      }),
    };
  });

  /** Тестовое письмо. Без `to` уходит на адрес администратора, которым он вошёл. */
  app.post("/api/admin/mail/test", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    applyNoStoreToReply(reply);

    const body = testSchema.parse(request.body);
    const to = (body.to ?? admin.admin.email).trim().toLowerCase();
    const reason = unusableEmailReason(to);
    if (reason) return reply.code(400).send({ error: "На этот адрес письмо не отправить: " + reason });

    const config = postboxConfig();
    const status = await postboxStatus(config);
    if (!status.configured) return reply.code(409).send({ error: status.reason });

    // В тестовом письме личные данные не подставляются: вместо них прочерк, чтобы человек видел,
    // где именно в тексте стоит подстановка.
    const mail = renderMail(
      { subject: body.subject, body: body.body },
      { email: to, name: "проверка" },
      { plan: "—", project: "—", platformUrl: config.platformUrl },
    );
    try {
      const result = await sendPostboxEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
      await recordAudit({
        action: "mail.test",
        actorType: "admin",
        actorId: admin.admin.id,
        actorLabel: admin.admin.email,
        ip: request.ip,
        details: { to: maskEmail(to), messageId: result.messageId },
      });
      return {
        ok: true,
        to,
        messageId: result.messageId,
        sentAt: new Date().toISOString(),
        note: "Тег {{plan}} и {{project}} заменены прочерком: у тестового письма нет аккаунта.",
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await recordAudit({
        action: "mail.test.failed",
        actorType: "admin",
        actorId: admin.admin.id,
        actorLabel: admin.admin.email,
        ip: request.ip,
        details: { to: maskEmail(to), error: text.slice(0, 300) },
      });
      return reply.code(502).send({ error: "Postbox не принял письмо: " + text });
    }
  });

  /** Поставить рассылку в очередь. Число получателей подтверждается числом, а не галочкой. */
  app.post("/api/admin/mail/send", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    applyNoStoreToReply(reply);

    const body = sendSchema.parse(request.body);
    const segmentId = segmentOf(body.segmentId);
    if (!segmentId) {
      return reply.code(400).send({ error: "Неизвестный сегмент: " + body.segmentId });
    }
    const status = await postboxStatus();
    if (!status.configured) return reply.code(409).send({ error: status.reason });

    // Сегмент пересчитывается здесь заново: между предпросмотром и отправкой он меняется, и
    // расхождение — не «мелкая неточность», а другой список людей.
    const audience = await loadAudience(segmentId);
    if (audience.members.length !== body.confirm) {
      return reply.code(409).send({ error: "Число получателей изменилось: " + audience.members.length });
    }
    if (!audience.members.length) {
      return reply.code(409).send({ error: "В сегменте нет ни одного адреса, готового к отправке" });
    }

    const campaign = await createCampaign({
      subject: body.subject.trim(),
      body: body.body,
      segmentId,
      segmentLabel: segmentById(segmentId).label,
      createdBy: admin.admin.email,
      recipients: audience.members.map(member => ({ userId: member.userId, email: member.email, name: member.name })),
    });
    await recordAudit({
      action: "mail.send",
      actorType: "admin",
      actorId: admin.admin.id,
      actorLabel: admin.admin.email,
      ip: request.ip,
      details: { campaignId: campaign.id, segmentId, recipients: campaign.recipients, subject: campaign.subject },
    });
    return { ok: true, campaign };
  });

  /** Остановка очереди: уже отправленные письма не отзываются, остальные пропускаются. */
  app.post("/api/admin/mail/campaigns/:id/stop", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    applyNoStoreToReply(reply);

    const params = z.object({ id: z.string().min(1).max(80) }).parse(request.params);
    const campaign = await getCampaign(params.id);
    if (!campaign) return reply.code(404).send({ error: "Кампания не найдена" });
    if (campaign.status !== "queued" && campaign.status !== "sending") {
      return reply.code(409).send({ error: "Рассылка уже завершена: " + campaign.status });
    }
    const stopped = await requestCampaignStop(campaign.id);
    await recordAudit({
      action: "mail.stop",
      actorType: "admin",
      actorId: admin.admin.id,
      actorLabel: admin.admin.email,
      ip: request.ip,
      details: { campaignId: campaign.id, sent: campaign.sent, recipients: campaign.recipients },
    });
    return { ok: true, campaign: stopped };
  });
}
