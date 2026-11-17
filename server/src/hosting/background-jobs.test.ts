import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
process.env.WEBNESTDEV_DATA_DIR = await mkdtemp(path.join(tmpdir(), "background-jobs-"));

const { enqueueBackgroundJobs, publicBackgroundJob } = await import("./background-jobs.js");
const { HostingError } = await import("./types.js");

const site = {
  id: "site-1",
  userId: "user-1",
  projectId: "project-1",
  slug: "demo",
  status: "live" as const,
  activeReleaseId: "abcdef01",
  publishingReleaseId: null,
  nodeId: "node-1",
  lastError: "",
  suspendReason: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  unpublishedAt: null,
  suspendedAt: null,
};

test("на бесплатном тарифе фоновые задания отклоняются до чтения релиза", async () => {
  await assert.rejects(
    () => enqueueBackgroundJobs({ site, requests: [{ name: "send-receipt", payload: {} }] }),
    (error: unknown) => error instanceof HostingError && error.code === "BACKGROUND_JOBS_PLAN_REQUIRED",
  );
});

test("публичное представление не отдаёт payload и сырой результат", () => {
  const view = publicBackgroundJob({
    id: "job-1",
    kind: "hosting.job",
    subject: "site-1:order:1",
    projectId: "project-1",
    userId: "user-1",
    state: "done",
    attempts: 1,
    maxAttempts: 3,
    runAfter: "2026-01-01T00:00:00.000Z",
    lockedUntil: null,
    lockedBy: "",
    lastError: "",
    progressDone: 1,
    progressTotal: 1,
    siteId: "site-1",
    releaseId: "abcdef01",
    functionName: "send-receipt",
    payloadJson: '{"secret":"not returned"}',
    resultJson: '{"status":200}',
    priority: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(view.name, "send-receipt");
  assert.deepEqual(view.result, { status: 200 });
  assert.equal("payloadJson" in view, false);
  assert.equal("payload" in view, false);
});
