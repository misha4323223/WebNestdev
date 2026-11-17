import { randomUUID } from "node:crypto";
import path from "node:path";
import { accountPlanFor } from "../billing/store.js";
import { planAllows } from "../account/entitlements.js";
import { enqueueJob, listJobs, type JobRecord } from "../jobs/store.js";
import type { BackgroundJobRequest } from "../functions/invoke.js";
import { readReleaseManifest } from "../functions/release-manifest.js";
import { hostingFunctionsDir } from "./paths.js";
import { HostingError, type HostingSite } from "./types.js";

/**
 * Постановка фоновых заданий опубликованного сайта.
 *
 * Задание привязано к конкретному релизу: после rollback старый код не должен продолжать
 * выполняться под новым сайтом. Дедупликация идёт по `siteId + idempotencyKey`; без ключа
 * создаётся отдельное задание. Лимит активных заданий защищает общий worker от одного
 * клиента, который поставил тысячи писем.
 */

export const BACKGROUND_JOBS_MAX_ACTIVE_PER_PROJECT = 100;
export const BACKGROUND_JOB_DEFAULT_PRIORITY = 10;

function planError(site: HostingSite) {
  return new HostingError(
    "BACKGROUND_JOBS_PLAN_REQUIRED",
    "Фоновые задания доступны на тарифе «Премиум». На «Плюсе» остаются статические сайты и HTTP-функции.",
    403,
  );
}

async function activeCount(projectId: string) {
  const [queued, running] = await Promise.all([
    listJobs({ projectId, kind: "hosting.job", state: "queued", limit: BACKGROUND_JOBS_MAX_ACTIVE_PER_PROJECT }),
    listJobs({ projectId, kind: "hosting.job", state: "running", limit: BACKGROUND_JOBS_MAX_ACTIVE_PER_PROJECT }),
  ]);
  return queued.length + running.length;
}

export async function enqueueBackgroundJobs(input: {
  site: HostingSite;
  requests: BackgroundJobRequest[];
  now?: Date;
}): Promise<JobRecord[]> {
  const { site, requests } = input;
  if (!requests.length) return [];
  if (site.status !== "live" || !site.activeReleaseId) {
    throw new HostingError("SITE_NOT_FOUND", "Сайт не опубликован: фоновые задания недоступны", 409);
  }
  const plan = await accountPlanFor(site.userId);
  if (!planAllows(plan, "backgroundJobs")) throw planError(site);

  const manifest = await readReleaseManifest(
    path.join(hostingFunctionsDir(site.slug, site.activeReleaseId), "manifest.json"),
  );
  const available = new Set((manifest?.jobs ?? []).map(job => job.name));
  if (!available.size) {
    throw new HostingError("BACKGROUND_JOB_NOT_FOUND", "В активном релизе нет фоновых обработчиков", 404);
  }
  for (const request of requests) {
    if (!available.has(request.name)) {
      throw new HostingError("BACKGROUND_JOB_NOT_FOUND", "Фоновое задание не найдено: " + request.name, 404);
    }
  }
  if (await activeCount(site.projectId) + requests.length > BACKGROUND_JOBS_MAX_ACTIVE_PER_PROJECT) {
    throw new HostingError(
      "BACKGROUND_JOB_LIMIT",
      "Слишком много активных фоновых заданий: дождитесь выполнения или сократите очередь",
      429,
    );
  }

  const jobs: JobRecord[] = [];
  for (const request of requests) {
    const payloadJson = JSON.stringify(request.payload ?? {});
    const subject = site.id + ":" + (request.idempotencyKey ?? randomUUID());
    jobs.push(await enqueueJob({
      kind: "hosting.job",
      projectId: site.projectId,
      userId: site.userId,
      subject,
      siteId: site.id,
      releaseId: site.activeReleaseId,
      functionName: request.name,
      payloadJson,
      priority: BACKGROUND_JOB_DEFAULT_PRIORITY,
      ...(input.now ? { now: input.now } : {}),
    }));
  }
  return jobs;
}

export function publicBackgroundJob(job: JobRecord) {
  return {
    id: job.id,
    siteId: job.siteId,
    releaseId: job.releaseId,
    name: job.functionName,
    state: job.state,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    priority: job.priority,
    lastError: job.lastError,
    result: job.resultJson ? safeJson(job.resultJson) : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

function safeJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
