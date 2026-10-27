import { accountPlanFor } from "../billing/store.js";
import { listProjects } from "../project-store.js";
import { maskEmail, unusableEmailReason } from "./address.js";
import {
  campaignCounters,
  campaignsInProgress,
  markRecipient,
  nextQueuedRecipient,
  requeueStuck,
  sentSince,
  suppressionMap,
  updateCampaign,
} from "./mail-store.js";
import { postboxConfig, sendPostboxEmail } from "./postbox.js";
import { planLabel } from "./segments.js";
import { renderSubject, renderText, textToHtml, unsubscribeFooter, unsubscribeUrl } from "./render.js";
import type { MailCampaign } from "./types.js";

/**
 * Очередь рассылки: одно письмо за тик.
 *
 * Тик в секунду — это не «как получилось», а предел Postbox: на старте у сервиса квота 1 письмо
 * в секунду и 200 в сутки. Поэтому очередь считает отправленное по своей таблице за последние
 * сутки и останавливается сама, когда предел выбран, — иначе Postbox начнёт отвечать отказами, а
 * половина писем уйдёт в `failed` без пользы.
 *
 * Состояние очереди живёт в базе, а не в памяти процесса. Рассылка на 1 500 адресов при секунде
 * на письмо идёт почти полчаса; выкатка сервера посреди неё не должна ни терять письма, ни
 * отправлять их дважды: при старте письмо, застрявшее в состоянии `sending`, возвращается в
 * очередь.
 *
 * Отписки проверяются перед каждым письмом, а не один раз при постановке: человек нажимает
 * ссылку в полученном письме, и следующее письмо ему уже не уходит.
 */

const MAX_ATTEMPTS = 3;

export type QueueDeps = {
  send: typeof sendPostboxEmail;
  now: () => Date;
  /** Пределы читаются на каждый тик: значения в панели могут измениться без перезапуска. */
  limits: () => { perSecond: number; dailyLimit: number };
};

const defaultDeps: QueueDeps = {
  send: sendPostboxEmail,
  now: () => new Date(),
  limits: () => {
    const config = postboxConfig();
    return { perSecond: config.perSecond, dailyLimit: config.dailyLimit };
  },
};

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export type RenderedMail = { subject: string; text: string; html: string };

/**
 * Письмо для одного человека. Подстановки раскрываются здесь, потому что `{{project}}` и
 * `{{plan}}` — это данные аккаунта, а не кампании.
 *
 * Ссылка отписки дописывается в конец, если автор письма не поставил тег `{{unsubscribe}}` сам:
 * письмо без отписки превращается в жалобу «спам», а это бьёт по репутации домена сильнее, чем
 * сама отписка.
 */
export function renderMail(
  campaign: Pick<MailCampaign, "subject" | "body">,
  recipient: { email: string; name: string },
  extras: { plan: string; project: string; platformUrl: string },
): RenderedMail {
  const url = unsubscribeUrl(extras.platformUrl, recipient.email);
  const localPart = recipient.email.split("@")[0] ?? "";
  const tags = {
    name: recipient.name || localPart,
    email: recipient.email,
    project: extras.project,
    plan: extras.plan,
    unsubscribe: url,
  };
  const subject = renderSubject(campaign.subject, tags);
  const body = renderText(campaign.body, tags);
  const text = body.includes(url) ? body : body + "\n\n" + unsubscribeFooter(url);
  return { subject, text, html: textToHtml(text, url) };
}

export type MailRecipientRef = { userId: string; email: string; name: string };

/**
 * Данные аккаунта для подстановок: тариф и последний проект. Экспортируется, чтобы предпросмотр
 * показывал ровно те же письма, что уйдут: подстановки делает один и тот же код.
 */
export async function accountTags(userId: string, platformUrl: string) {
  const [plan, projects] = await Promise.all([
    userId ? accountPlanFor(userId).catch(() => "free" as const) : Promise.resolve("free" as const),
    userId ? listProjects(userId).catch(() => []) : Promise.resolve([]),
  ]);
  return { plan: planLabel(plan), project: projects[0]?.name ?? "проект", platformUrl };
}

export type TickResult = {
  state: "idle" | "limited" | "stopped" | "finished" | "sent" | "failed" | "skipped" | "pending";
  campaignId?: string;
  email?: string;
  error?: string;
};

/**
 * Один шаг очереди. Возвращает состояние шага, а не только отправленное письмо: по нему пишется
 * лог и видно, что очередь делает прямо сейчас (идёт, уперлась в предел, завершилась).
 */
export async function mailTick(deps: QueueDeps = defaultDeps): Promise<TickResult> {
  const campaigns = await campaignsInProgress();
  if (!campaigns.length) return { state: "idle" };
  const campaign = campaigns[0];
  const { perSecond, dailyLimit } = deps.limits();
  void perSecond;

  // Остановку проверяем до отправки: она означает «дальше не пишем», включая текущее письмо.
  if (campaign.stopRequested) {
    return finishCampaign(campaign, "stopped", deps);
  }

  const sentToday = await sentSince(new Date(deps.now().getTime() - 24 * 60 * 60 * 1000));
  if (sentToday >= dailyLimit) {
    const note = "Достигнут суточный предел Postbox: " + sentToday + " из " + dailyLimit + " писем за сутки. Очередь продолжится сама, когда предел освободится.";
    if (campaign.error !== note) {
      await updateCampaign(campaign.id, { error: note, status: "sending" });
      console.warn("[mail] " + note + " (кампания " + campaign.id + ")");
    }
    return { state: "limited", campaignId: campaign.id };
  }

  const recipient = await nextQueuedRecipient(campaign.id);
  if (!recipient) return finishCampaign(campaign, "sent", deps);

  if (campaign.status !== "sending" || !campaign.startedAt) {
    await updateCampaign(campaign.id, { status: "sending", startedAt: campaign.startedAt ?? deps.now().toISOString(), error: "" });
  }

  const reason = unusableEmailReason(recipient.email);
  if (reason) {
    await markRecipient(campaign.id, recipient.email, { status: "skipped", error: reason });
    await refreshCounters(campaign.id);
    return { state: "skipped", campaignId: campaign.id, email: maskEmail(recipient.email), error: reason };
  }

  const suppressions = await suppressionMap();
  const suppressed = suppressions.get(recipient.email);
  if (suppressed) {
    await markRecipient(campaign.id, recipient.email, { status: "skipped", error: "отписка: " + suppressed.reason });
    await refreshCounters(campaign.id);
    return { state: "skipped", campaignId: campaign.id, email: maskEmail(recipient.email), error: "отписка" };
  }

  await markRecipient(campaign.id, recipient.email, { status: "sending" });
  const extras = await accountTags(recipient.userId, postboxConfig().platformUrl);
  const mail = renderMail(campaign, recipient, extras);
  try {
    const result = await deps.send({ to: recipient.email, subject: mail.subject, text: mail.text, html: mail.html });
    await markRecipient(campaign.id, recipient.email, { status: "sent", messageId: result.messageId });
    await refreshCounters(campaign.id);
    return { state: "sent", campaignId: campaign.id, email: maskEmail(recipient.email) };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const attempts = recipient.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await markRecipient(campaign.id, recipient.email, { status: "failed", error: text, countAttempt: true });
      console.error("[mail] письмо не ушло после " + attempts + " попыток (" + maskEmail(recipient.email) + "): " + text);
    } else {
      // Письмо возвращается в конец очереди: один недоставленный адрес не задерживает остальных.
      await markRecipient(campaign.id, recipient.email, { status: "queued", error: text, countAttempt: true });
      console.warn("[mail] попытка " + attempts + " не удалась (" + maskEmail(recipient.email) + "): " + text);
    }
    await refreshCounters(campaign.id);
    return { state: "failed", campaignId: campaign.id, email: maskEmail(recipient.email), error: text };
  }
}

async function refreshCounters(campaignId: string) {
  const counters = await campaignCounters(campaignId);
  await updateCampaign(campaignId, { sent: counters.sent, failed: counters.failed, skipped: counters.skipped });
}

/**
 * Завершение кампании. Остаток очереди помечается пропущенным, а не остаётся висеть: иначе
 * кампания с остановкой выглядела бы как незаконченная и её «продолжение» отправило бы письма
 * после того, как человек сказал «стоп».
 */
async function finishCampaign(campaign: MailCampaign, status: "sent" | "stopped", deps: QueueDeps): Promise<TickResult> {
  let guard = 0;
  while (guard < 10_000) {
    const recipient = await nextQueuedRecipient(campaign.id);
    if (!recipient) break;
    await markRecipient(campaign.id, recipient.email, { status: "skipped", error: status === "stopped" ? "рассылка остановлена" : "не отправлено" });
    guard += 1;
  }
  const counters = await campaignCounters(campaign.id);
  const finalStatus = status === "stopped" || counters.sent > 0 || counters.failed === 0 ? status : "failed";
  await updateCampaign(campaign.id, {
    status: finalStatus,
    finishedAt: deps.now().toISOString(),
    sent: counters.sent,
    failed: counters.failed,
    skipped: counters.skipped,
    error: finalStatus === "failed" ? "Ни одно письмо не ушло: смотрите причину в карточке кампании." : "",
  });
  console.log("[mail] рассылка " + campaign.id + " завершена: " + finalStatus + ", отправлено " + counters.sent + ", ошибок " + counters.failed + ", пропущено " + counters.skipped);
  return { state: finalStatus === "failed" ? "failed" : status === "stopped" ? "stopped" : "finished", campaignId: campaign.id };
}

/** Продолжает незаконченные кампании после перезапуска сервера: очередь возобновляется сама. */
export async function resumeMailQueue() {
  const stuck = await requeueStuck();
  if (stuck) console.log("[mail] возвращено в очередь писем, застрявших на перезапуске: " + stuck);
  const campaigns = await campaignsInProgress();
  if (campaigns.length) console.log("[mail] незаконченных рассылок: " + campaigns.length + " — очередь продолжается");
  return { resumed: campaigns.length, requeued: stuck };
}

export function startMailQueue(deps: QueueDeps = defaultDeps) {
  if (timer) return;
  void resumeMailQueue().catch(error => console.error("[mail] возобновление очереди:", error));
  const interval = () => Math.max(200, Math.round(1000 / deps.limits().perSecond));
  const schedule = () => {
    timer = setTimeout(async () => {
      if (!ticking) {
        ticking = true;
        try {
          await mailTick(deps);
        } catch (error) {
          console.error("[mail] очередь:", error instanceof Error ? error.message : error);
        } finally {
          ticking = false;
        }
      }
      if (timer) schedule();
    }, interval());
    timer.unref();
  };
  schedule();
}

export function stopMailQueue() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Что делает очередь прямо сейчас: админка показывает это в шапке рассылок. */
export async function mailQueueSnapshot() {
  const campaigns = await campaignsInProgress();
  const active = campaigns[0] ?? null;
  if (!active) return null;
  return {
    campaignId: active.id,
    subject: active.subject,
    status: active.status,
    stopRequested: active.stopRequested,
    sent: active.sent,
    failed: active.failed,
    skipped: active.skipped,
    recipients: active.recipients,
  };
}
