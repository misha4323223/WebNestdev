import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

// Каталоги читаются при импорте хранилищ — как и в самом сервере, окружение задаётся до импорта.
const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-projects-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");
process.env.WEBNESTDEV_STORAGE = "json";
for (const name of ["PLATFORM_S3_ENDPOINT", "PLATFORM_S3_BUCKET", "PLATFORM_S3_ACCESS_KEY_ID", "PLATFORM_S3_SECRET_ACCESS_KEY"]) {
  delete process.env[name];
}

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { registerProjectRoutes } = await import("./projects.js");

after(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

let counter = 0;
async function appWithProject() {
  const user = await createUser("archive-" + ++counter + "@example.com", "password-123");
  const other = await createUser("archive-other-" + ++counter + "@example.com", "password-123");
  const project = await createProject("Архив", undefined, user.id);
  const app = Fastify();
  await app.register(cookie);
  await registerProjectRoutes(app);
  await app.ready();
  return {
    app,
    projectId: project.id,
    userId: user.id,
    headers: { cookie: "webnestdev_session=" + (await createSession(user.id)).id },
    otherHeaders: { cookie: "webnestdev_session=" + (await createSession(other.id)).id },
  };
}

test("проект без архива отдаёт archived:false и пустой разбор архива", async () => {
  const { app, projectId, headers } = await appWithProject();
  try {
    const project = await app.inject({ method: "GET", url: "/api/projects/" + projectId, headers });
    assert.equal(project.statusCode, 200);
    assert.equal(project.json().archived, false);

    const archive = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/archive", headers });
    assert.equal(archive.statusCode, 200);
    assert.deepEqual(archive.json(), {
      archived: false,
      bytes: 0,
      archivedAt: null,
      restoring: false,
      bytesDone: 0,
      bytesTotal: 0,
      phase: null,
      jobId: null,
      error: null,
    });
  } finally {
    await app.close();
  }
});

test("без настроенного бакета архивация отвечает причиной, а не 500", async () => {
  const { app, projectId, headers } = await appWithProject();
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/archive", headers });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "ARCHIVE_FAILED");
    assert.match(response.json().error, /Объектное хранилище не настроено/);
  } finally {
    await app.close();
  }
});

test("восстанавливать нечего — ответ 200 без задания, а не 202", async () => {
  const { app, projectId, headers } = await appWithProject();
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/restore", headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      archived: false,
      restored: false,
      restoring: false,
      jobId: null,
      bytesDone: 0,
      bytesTotal: 0,
      phase: null,
    });
  } finally {
    await app.close();
  }
});

test("архивный проект отвечает 202 с jobId, а статус отдаёт прогресс", async () => {
  const { app, projectId, userId, headers } = await appWithProject();
  // Проверяется контракт API: задание уже идёт, поэтому маршруту не нужен настоящий бакет.
  const { startRestoreJob } = await import("../storage/restore-jobs.js");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const job = startRestoreJob({
    projectId,
    userId,
    bytesTotal: 1000,
    run: async progress => {
      progress(400, 1000, "downloading");
      await gate;
      return false;
    },
  });
  try {
    const started = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/restore", headers });
    assert.equal(started.statusCode, 202);
    assert.equal(started.json().jobId, job.id);
    assert.equal(started.json().bytesTotal, 1000);
    assert.equal(started.json().restoring, true);

    const status = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/archive", headers });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), {
      archived: false,
      bytes: 1000,
      archivedAt: null,
      restoring: true,
      bytesDone: 400,
      bytesTotal: 1000,
      phase: "downloading",
      jobId: job.id,
      error: null,
    });
  } finally {
    release();
    await app.close();
  }
});

test("чужой проект не архивируется и не восстанавливается", async () => {
  const { app, projectId, otherHeaders } = await appWithProject();
  try {
    for (const action of ["archive", "restore"]) {
      const response = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/" + action, headers: otherHeaders });
      assert.equal(response.statusCode, 404);
    }
    const info = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/archive", headers: otherHeaders });
    assert.equal(info.statusCode, 404);
  } finally {
    await app.close();
  }
});
