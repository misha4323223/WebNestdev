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
    assert.deepEqual(archive.json(), { archived: false, bytes: 0, archivedAt: null });
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
