import path from "node:path";
import { getSite } from "./site-store.js";
import { hostingFunctionDir, hostingFunctionsDir } from "./paths.js";
import { invokeFunction } from "../functions/invoke.js";
import { readReleaseManifest } from "../functions/release-manifest.js";
import { projectFunctionEnv } from "../functions/runtime-env.js";
import type { JobRecord } from "../jobs/store.js";

/**
 * Выполняет задание, только если сайт всё ещё работает на том релизе, который поставил его
 * в очередь. После rollback или снятия сайта задание не должно запускать старый код.
 */
export async function runBackgroundJob(job: JobRecord): Promise<{ done: number; total: number; resultJson: string }> {
  if (!job.siteId || !job.releaseId || !job.functionName) {
    throw new Error("фоновое задание без сайта, релиза или обработчика");
  }
  const site = await getSite(job.siteId);
  if (!site || site.status !== "live") throw new Error("сайт не опубликован");
  if (site.activeReleaseId !== job.releaseId) throw new Error("релиз задания больше не активен");

  const manifest = await readReleaseManifest(
    path.join(hostingFunctionsDir(site.slug, job.releaseId), "manifest.json"),
  );
  const fn = manifest?.jobs?.find(item => item.name === job.functionName);
  if (!fn) throw new Error("обработчик задания не найден в релизе");

  let payload: unknown = {};
  if (job.payloadJson) {
    try {
      payload = JSON.parse(job.payloadJson);
    } catch {
      throw new Error("payload задания — невалидный JSON");
    }
  }
  const env = await projectFunctionEnv(site.projectId);
  const response = await invokeFunction({
    artifactDir: hostingFunctionDir(site.slug, job.releaseId, job.functionName),
    fn,
    request: {
      method: "JOB",
      path: "/__job__",
      query: "",
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    },
    env,
    maxTimeoutMs: 60_000,
  });
  return {
    done: 1,
    total: 1,
    resultJson: JSON.stringify({ status: response.status, bytes: response.body.byteLength }),
  };
}
