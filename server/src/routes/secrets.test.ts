import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerSecretRoutes, type SecretRouteDeps } from "./secrets.js";
import { requestSecret, resolveSecretRequest } from "../secrets/pending-secrets.js";

async function tempRoot(initial?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "wnd-secret-"));
  if (initial !== undefined) await writeFile(path.join(root, ".env.local"), initial, "utf8");
  return root;
}

async function appWith(root: string, overrides: Partial<SecretRouteDeps> = {}) {
  const app = Fastify();
  await registerSecretRoutes(app, {
    authorize: async () => ({ id: "u1" }),
    getProject: async id => ({ id, userId: "u1" }),
    getSandboxRoot: async () => root,
    ...overrides,
  });
  await app.ready();
  return app;
}

test("значение из окна уходит в файл проекта, а в ответе и модели его нет", async () => {
  const root = await tempRoot("KEEP=1\n");
  const { request, answer } = requestSecret({ projectId: "p1", userId: "u1", variable: "STRIPE_SECRET_KEY", purpose: "Оплата", file: ".env.local" });
  const app = await appWith(root);
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/secrets", payload: { requestId: request.id, value: "sk_live_12345" } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body, { ok: true, variable: "STRIPE_SECRET_KEY", file: ".env.local", delivered: true });
    assert.ok(!JSON.stringify(body).includes("sk_live_12345"), "значение не должно возвращаться в браузер");

    const file = await readFile(path.join(root, ".env.local"), "utf8");
    assert.match(file, /KEEP=1/);
    assert.match(file, /STRIPE_SECRET_KEY=sk_live_12345/);
    assert.deepEqual(await answer, { ok: true, variable: "STRIPE_SECRET_KEY", file: ".env.local" });
  } finally { await app.close(); }
});

test("многострочный ключ записывается одной строкой и не ломает файл", async () => {
  const root = await tempRoot("");
  const { request, answer } = requestSecret({ projectId: "p1", userId: "u1", variable: "PRIVATE_KEY", purpose: "Подпись", file: ".env.local" });
  const app = await appWith(root);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/p1/secrets",
      payload: { requestId: request.id, value: "-----BEGIN KEY-----\nMIIB\n-----END KEY-----" },
    });
    assert.equal(response.statusCode, 200);
    const file = await readFile(path.join(root, ".env.local"), "utf8");
    assert.equal(file.split("\n").filter(Boolean).length, 1, file);
    assert.equal(file, 'PRIVATE_KEY="-----BEGIN KEY-----\\nMIIB\\n-----END KEY-----"\n');
    await answer;
  } finally { await app.close(); }
});

test("устаревшее окно ничего не пишет и не отдаёт значение обратно", async () => {
  const root = await tempRoot("KEEP=1\n");
  const app = await appWith(root);
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/secrets", payload: { requestId: "нет-такого", value: "sk_live_12345" } });
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes("sk_live_12345"));
    assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "KEEP=1\n");
  } finally { await app.close(); }
});

test("отмена закрывает ожидание инструмента отказом", async () => {
  const root = await tempRoot("");
  const { request, answer } = requestSecret({ projectId: "p1", userId: "u1", variable: "TOKEN", purpose: "", file: ".env.local" });
  const app = await appWith(root);
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p1/secrets/" + request.id + "/cancel" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { cancelled: true });
    assert.deepEqual(await answer, { ok: false, cancelled: true });
  } finally { await app.close(); }
});

test("проект другого аккаунта закрыт так же, как несуществующий", async () => {
  const root = await tempRoot("");
  const { request } = requestSecret({ projectId: "p2", userId: "u1", variable: "TOKEN", purpose: "", file: ".env.local" });
  const app = await appWith(root, { getProject: async id => ({ id, userId: "u2" }) });
  try {
    const response = await app.inject({ method: "POST", url: "/api/projects/p2/secrets", payload: { requestId: request.id, value: "sk_live_12345" } });
    assert.equal(response.statusCode, 404);
    assert.match(response.body, /Проект не найден/);
  } finally {
    resolveSecretRequest(request.id, { ok: false, cancelled: true });
    await app.close();
  }
});
