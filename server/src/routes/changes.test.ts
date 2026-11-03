import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

/** Каталоги хранилища читаются при импорте модулей, поэтому задаются до первого импорта. */
const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-changes-routes-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { createCheckpoint, initRepo } = await import("../changes/git-repo.js");
const { registerChangesRoutes } = await import("./changes.js");

type RepositoryRef = Parameters<typeof createProject>[1];

async function appWithProject(repository?: RepositoryRef) {
  const user = await createUser("changes-" + randomUUID() + "@example.com", "password-123");
  const project = await createProject("Git-панель", repository, user.id);
  const session = await createSession(user.id);
  const root = sandboxRootPath(project.id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "index.html"), "<h1>Старое</h1>\n");
  await initRepo(root, { branch: "main" });
  await createCheckpoint(root, { branch: "main", subject: "Начало", kind: "imported" });
  await writeFile(path.join(root, "index.html"), "<h1>Старое</h1>\n<p>Новое</p>\n");
  await writeFile(path.join(root, ".env.local"), "SECRET_VALUE=do-not-leak\n");

  const app = Fastify();
  await app.register(cookie);
  await registerChangesRoutes(app);
  await app.ready();
  return { app, projectId: project.id, headers: { cookie: "webnestdev_session=" + session.id } };
}

test("бесплатный тариф не отправляет коммиты в подключённый репозиторий", async () => {
  const { app, projectId, headers } = await appWithProject({
    provider: "github",
    owner: "owner",
    name: "repo",
    fullName: "owner/repo",
    defaultBranch: "main",
    url: "https://github.com/owner/repo",
  });
  try {
    const overview = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/changes", headers });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().repository.pushAllowed, false);

    const push = await app.inject({ method: "POST", url: "/api/projects/" + projectId + "/changes/push", headers });
    assert.equal(push.statusCode, 403);
    assert.equal(push.json().code, "PUSH_REQUIRES_PAID_PLAN");
    assert.match(push.json().error, /бесплатном тарифе/);

    // Коммит остаётся локальным даже если старый клиент всё ещё присылает push:true.
    const commit = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/changes/commit",
      headers,
      payload: { message: "Локальная точка", paths: ["index.html"], push: true },
    });
    assert.equal(commit.statusCode, 200);
    assert.equal(commit.json().pushed, false);
    assert.match(commit.json().pushError, /бесплатном тарифе/);
  } finally {
    await app.close();
  }
});

test("бесплатный тариф не создаёт удалённый репозиторий", async () => {
  const { app, projectId, headers } = await appWithProject();
  try {
    const create = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/changes/repository",
      headers,
      payload: { name: "free-project" },
    });
    assert.equal(create.statusCode, 403, "создание удалённого репозитория тоже не обходит тариф");
    assert.equal(create.json().code, "PUSH_REQUIRES_PAID_PLAN");
  } finally {
    await app.close();
  }
});

test("Git-панель: рабочие изменения, diff, выборочный коммит и ветка", async () => {
  const { app, projectId, headers } = await appWithProject();
  try {
    const worktree = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/changes/worktree", headers });
    assert.equal(worktree.statusCode, 200);
    const files = worktree.json().files as Array<{ path: string; status: string }>;
    assert.deepEqual(files.map(file => file.path), ["index.html"], "секретный env-файл не показывается");

    const diff = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/changes/diff?path=index.html", headers });
    assert.equal(diff.statusCode, 200);
    assert.match(diff.json().patch, /^\+<p>Новое<\/p>$/m);

    const secret = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/changes/diff?path=.env.local", headers });
    assert.equal(secret.statusCode, 400);
    assert.doesNotMatch(secret.body, /do-not-leak/);

    const commit = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/changes/commit",
      headers,
      payload: { message: "Обновить страницу", paths: ["index.html"] },
    });
    assert.equal(commit.statusCode, 200);
    const body = commit.json();
    assert.equal(body.checkpoint.kind, "manual");
    assert.equal(body.checkpoint.filesChanged, 1);
    assert.equal(body.pushed, false, "коммит сам не отправляется");

    const clean = await app.inject({ method: "GET", url: "/api/projects/" + projectId + "/changes/worktree", headers });
    assert.deepEqual(clean.json().files, []);

    const branch = await app.inject({
      method: "POST",
      url: "/api/projects/" + projectId + "/changes/branches",
      headers,
      payload: { name: "feature" },
    });
    assert.equal(branch.statusCode, 200);
    assert.equal(branch.json().branch, "feature");
    assert.equal(branch.json().overview.repository.branch, "feature");
  } finally {
    await app.close();
  }
});
