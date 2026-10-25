import test from "node:test";
import assert from "node:assert/strict";
import { isSandboxJobName, sandboxJobMaxMs, sandboxJobName, tailSandboxJob } from "./jobs.js";

test("имя задания — валидное имя контейнера и не содержит чужих символов", () => {
  const name = sandboxJobName("project / with: bad chars");
  assert.match(name, /^wnd-job-[A-Za-z0-9_.-]+$/);
  assert.equal(isSandboxJobName(name), true);
  assert.equal(isSandboxJobName("wnd-cmd-project"), false);
  assert.equal(isSandboxJobName("../escape"), false);
});

test("срок задания ограничен сверху даже при большом значении из окружения", () => {
  const previous = process.env.SANDBOX_JOB_MAX_MS;
  try {
    delete process.env.SANDBOX_JOB_MAX_MS;
    assert.equal(sandboxJobMaxMs(), 30 * 60_000);
    process.env.SANDBOX_JOB_MAX_MS = "7200000";
    assert.equal(sandboxJobMaxMs(), 2 * 60 * 60_000, "два часа — верхняя граница, а не бесконечность");
    process.env.SANDBOX_JOB_MAX_MS = "1000";
    assert.equal(sandboxJobMaxMs(), 30 * 60_000, "слишком короткий срок не принимается");
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_JOB_MAX_MS;
    else process.env.SANDBOX_JOB_MAX_MS = previous;
  }
});

test("неизвестное задание не читается и не раскрывает чужой вывод", async () => {
  const result = await tailSandboxJob("project", "user", "wnd-job-other-1234", 50);
  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
  assert.equal(result.logs, "");
  assert.match(result.error ?? "", /не найдено/i);
});
