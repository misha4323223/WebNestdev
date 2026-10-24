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

async function appWithProject() {
  const user = await createUser("changes-" + randomUUID() + "@example.com", "password-123");
  const project = await createProject("Git-панель", undefined, user.id);
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
