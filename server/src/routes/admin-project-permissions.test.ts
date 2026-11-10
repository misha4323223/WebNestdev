import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.WEBNESTDEV_STORAGE = "json";
const root = await mkdtemp(path.join(tmpdir(), "admin-permissions-"));
process.env.WEBNESTDEV_DATA_DIR = root;

const Fastify = (await import("fastify")).default;
const { registerAdminProjectPermissionsRoutes } = await import("./admin-project-permissions.js");
const { repairProjectOwnership } = await import("../sandbox/ownership-repair.js");
const { createAdmin, createAdminSession } = await import("../admin/admin-store.js");
const { createUser } = await import("../auth/auth-store.js");
const { createProject } = await import("../project-store.js");

const app = Fastify();
const repaired: string[] = [];
const audited: Array<{ action: string; target?: string; details?: Record<string, unknown> }> = [];
let repairResult: {
  entries: number;
  repaired: number;
  failed: number;
  truncated: boolean;
  missing?: boolean;
} = { entries: 42, repaired: 3, failed: 0, truncated: false };

await registerAdminProjectPermissionsRoutes(app, {
  repair: async projectId => {
    repaired.push(projectId);
    return repairResult;
  },
  audit: async input => {
    audited.push({ action: input.action, target: input.target, details: input.details });
  },
});
await app.ready();

const admin = await createAdmin("permissions-admin@example.test", "correct-horse-battery");
const session = await createAdminSession(admin.id);
const auth = { authorization: "Bearer " + session.token };

test.after(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

test("ремонт прав закрыт без админ-сессии", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/projects/any/permissions",
  });
  assert.equal(response.statusCode, 401);
});

test("неизвестный проект — 404, отсутствие каталога — 409", async () => {
  const missing = await app.inject({
    method: "POST",
    url: "/api/admin/projects/no-such-project/permissions",
    headers: auth,
  });
  assert.equal(missing.statusCode, 404);

  const user = await createUser("permissions-owner@example.test", "user-password-123");
  const project = await createProject("Права", undefined, user.id);
  repairResult = { entries: 0, repaired: 0, failed: 0, truncated: false, missing: true };
  const noWorkspace = await app.inject({
    method: "POST",
    url: "/api/admin/projects/" + project.id + "/permissions",
    headers: auth,
  });
  assert.equal(noWorkspace.statusCode, 409);
  assert.equal(noWorkspace.json().code, "NO_WORKSPACE");
});

test("ремонт возвращает счётчики и попадает в аудит", async () => {
  const user = await createUser("permissions-run@example.test", "user-password-123");
  const project = await createProject("Ремонт", undefined, user.id);
  repaired.length = 0;
  audited.length = 0;
  repairResult = { entries: 42, repaired: 3, failed: 1, truncated: false };

  const response = await app.inject({
    method: "POST",
    url: "/api/admin/projects/" + project.id + "/permissions",
    headers: auth,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    projectId: project.id,
    entries: 42,
    repaired: 3,
    failed: 1,
    truncated: false,
  });
  assert.deepEqual(repaired, [project.id]);
  assert.deepEqual(audited, [
    {
      action: "admin.project.permissions",
      target: project.id,
      details: { entries: 42, repaired: 3, failed: 1, truncated: false },
    },
  ]);
});

test("обход рекурсивный, включая node_modules, и не идёт по симлинкам", async () => {
  const tree = await mkdtemp(path.join(tmpdir(), "ownership-repair-"));
  const outside = path.join(tree, "outside.txt");
  const project = path.join(tree, "project");
  await mkdir(path.join(project, "node_modules", "@types", "three"), { recursive: true });
  await writeFile(path.join(project, "node_modules", "@types", "three", "index.d.ts"), "x");
  await writeFile(outside, "секрет");
  await symlink(outside, path.join(project, "link-to-outside"));

  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const result = await repairProjectOwnership(project, { uid, gid });

  assert.equal(result.missing, undefined);
  assert.equal(result.failed, 0);
  // node_modules/@types, node_modules/@types/three, index.d.ts, симлинк, сама node_modules
  assert.ok(result.entries >= 5, "обход должен зайти внутрь node_modules");
  assert.equal(result.truncated, false);
  // Ссылка не должна уводить chown на файл вне проекта: владелец цели остаётся прежним.
  const target = await lstat(outside);
  assert.equal(target.uid, uid);

  await rm(tree, { recursive: true, force: true });
});

test("чужой владелец исправляется (только под root)", { skip: process.getuid?.() !== 0 }, async () => {
  const tree = await mkdtemp(path.join(tmpdir(), "ownership-foreign-"));
  const project = path.join(tree, "project");
  await mkdir(path.join(project, "node_modules", "pkg", "deep"), { recursive: true });
  await writeFile(path.join(project, "node_modules", "pkg", "deep", "a.js"), "x");
  const { chown } = await import("node:fs/promises");
  await chown(path.join(project, "node_modules", "pkg", "deep"), 65534, 65534);

  const result = await repairProjectOwnership(project, { uid: 1000, gid: 1000 });
  assert.ok(result.repaired >= 1, "каталог с чужим владельцем должен быть исправлен");
  assert.equal(result.failed, 0);
  const info = await lstat(path.join(project, "node_modules", "pkg", "deep"));
  assert.equal(info.uid, 1000);
  assert.equal(info.gid, 1000);

  await rm(tree, { recursive: true, force: true });
});
