import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getProject } from "../project-store.js";
import { assertInsideSandbox, getSandbox } from "../sandbox-manager.js";
import { mergeEnvFile } from "../database/env-file.js";
import { encodeEnvValue } from "../secrets/env-value.js";
import { findSecretRequest, resolveSecretRequest, type SecretRequest, type SecretResolution } from "../secrets/pending-secrets.js";

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const valueSchema = z.object({
  requestId: z.string().min(1).max(100),
  value: z.string().min(1).max(20_000),
});
const cancelSchema = z.object({ id: z.string().min(1).max(200), requestId: z.string().min(1).max(100) });

/**
 * Everything the route touches lives behind these dependencies, so the test can drive the whole path
 * — write the value, answer the waiting tool, refuse a stale window — without Docker, a real project
 * or a login. The defaults are the real product behaviour.
 */
export type SecretRouteDeps = {
  authorize: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string } | null>;
  getProject: (id: string) => Promise<{ id: string; userId: string } | null>;
  getSandboxRoot: (projectId: string, userId: string) => Promise<string>;
  findRequest: (id: string) => SecretRequest | null;
  resolveRequest: (id: string, resolution: SecretResolution) => boolean;
  writeSecret: (root: string, file: string, variable: string, value: string) => Promise<void>;
};

/** Значение в файл окружения: та же запись, которой пользуется `database.env`. */
async function writeSecretFile(root: string, file: string, variable: string, value: string) {
  const target = assertInsideSandbox(root, path.join(root, file));
  let existing = "";
  try { existing = await readFile(target, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, mergeEnvFile(existing, { [variable]: encodeEnvValue(value) }), "utf8");
}

const defaultDeps: SecretRouteDeps = {
  authorize: (request, reply) => requireUser(request, reply),
  getProject: async id => {
    const project = await getProject(id);
    return project ? { id: project.id, userId: project.userId } : null;
  },
  getSandboxRoot: async (projectId, userId) => (await getSandbox(projectId, userId)).root,
  findRequest: findSecretRequest,
  resolveRequest: resolveSecretRequest,
  writeSecret: writeSecretFile,
};

/**
 * Значение ключа идёт единственным путём: из модального окна в браузере прямо в файл окружения
 * проекта. Оно не возвращается в ответе, не пишется в переписку и не попадает в события запуска —
 * агент получает только подтверждение, что переменная сохранена. Именно поэтому маршрут живёт
 * отдельно от сокета агента: тот разговор о задаче, а этот — о секрете.
 */
export async function registerSecretRoutes(app: FastifyInstance, overrides: Partial<SecretRouteDeps> = {}) {
  const deps: SecretRouteDeps = { ...defaultDeps, ...overrides };

  app.post("/api/projects/:id/secrets", async (request, reply) => {
    const user = await deps.authorize(request, reply); if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const body = valueSchema.parse(request.body ?? {});
    const project = await deps.getProject(id);
    if (!project || project.userId !== user.id) return reply.code(404).send({ error: "Проект не найден" });

    const pending = deps.findRequest(body.requestId);
    // Чужой запрос не отличается от истёкшего: и то и другое — «окно устарело», без подсказок о том,
    // существует ли запрос у другого аккаунта.
    if (!pending || pending.projectId !== project.id || pending.userId !== user.id) {
      return reply.code(404).send({ error: "Запрос ключа устарел — попросите агента запросить его снова" });
    }

    const root = await deps.getSandboxRoot(project.id, user.id);
    await deps.writeSecret(root, pending.file, pending.variable, body.value);

    // Инструмент продолжает работу только после этой строки: пока файл не записан, агент ждёт.
    const delivered = deps.resolveRequest(pending.id, { ok: true, variable: pending.variable, file: pending.file });
    return { ok: true, variable: pending.variable, file: pending.file, delivered };
  });

  app.post("/api/projects/:id/secrets/:requestId/cancel", async (request, reply) => {
    const user = await deps.authorize(request, reply); if (!user) return;
    const { id, requestId } = cancelSchema.parse(request.params);
    const project = await deps.getProject(id);
    if (!project || project.userId !== user.id) return reply.code(404).send({ error: "Проект не найден" });
    const pending = deps.findRequest(requestId);
    if (!pending || pending.projectId !== project.id || pending.userId !== user.id) {
      return reply.code(404).send({ error: "Запрос ключа уже неактуален" });
    }
    deps.resolveRequest(pending.id, { ok: false, cancelled: true });
    return { cancelled: true };
  });
}
