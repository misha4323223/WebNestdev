import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

/**
 * The data and sandbox directories are read when the stores are imported, so this file sets them
 * first and only then loads the routes. That is the same order the server uses at startup.
 */
const dataRoot = await mkdtemp(path.join(tmpdir(), "wnd-workspace-"));
process.env.WEBNESTDEV_DATA_DIR = dataRoot;
process.env.WEBNESTDEV_SANDBOX_DIR = path.join(dataRoot, "sandboxes");

const { createUser, createSession } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");
const { sandboxRootPath } = await import("../sandbox/config.js");
const { registerWorkspaceRoutes } = await import("./workspace.js");

let emailCounter = 0;
async function setApp() {
  const user = await createUser("workspace-" + ++emailCounter + "@example.com", "password-123");
  const project = await createProject("Workspace", undefined, user.id);
  const session = await createSession(user.id);
  const root = sandboxRootPath(project.id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".env.local"), "SECRET_VALUE=do-not-leak\n");
  await writeFile(path.join(root, ".env.example"), "PUBLIC_VALUE=\n");
  await writeFile(path.join(root, "src.ts"), "export const ok = true;\n");

  const app = Fastify();
  await app.register(cookie);
  await registerWorkspaceRoutes(app);
  await app.ready();
  return {
    app,
    projectId: project.id,
    headers: { cookie: "webnestdev_session=" + session.id },
  };
}

test("список файлов скрывает секретные env-файлы и не кэшируется", async () => {
  const { app, projectId, headers } = await setApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/files?path=.",
      headers,
    });
    assert.equal(response.statusCode, 200);
    const names = response.json().files.map((file: { name: string }) => file.name);
    assert.ok(names.includes("src.ts"));
    assert.ok(names.includes(".env.example"));
    assert.ok(!names.includes(".env.local"));
    assert.match(String(response.headers["cache-control"]), /no-store/);
  } finally { await app.close(); }
});

test("прямое открытие секретного файла — 403 без содержимого, шаблон открывается", async () => {
  const { app, projectId, headers } = await setApp();
  try {
    const secret = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/file?path=.env.local",
      headers,
    });
    assert.equal(secret.statusCode, 403);
    assert.doesNotMatch(secret.body, /do-not-leak|SECRET_VALUE/);
    assert.match(String(secret.headers["cache-control"]), /no-store/);

    const nested = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/file?path=apps/web/.env.production",
      headers,
    });
    assert.equal(nested.statusCode, 403);
    assert.doesNotMatch(nested.body, /SECRET/);

    const template = await app.inject({
      method: "GET",
      url: "/api/projects/" + projectId + "/file?path=.env.example",
      headers,
    });
    assert.equal(template.statusCode, 200);
    assert.match(template.json().content, /PUBLIC_VALUE/);
  } finally { await app.close(); }
});
