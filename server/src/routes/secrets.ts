import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getProject } from "../project-store.js";
import { getSandbox } from "../sandbox-manager.js";
import { findSecretRequest, resolveSecretRequest, type SecretRequest, type SecretResolution } from "../secrets/pending-secrets.js";
import { parseEnvFileContent } from "../platform/platform-env.js";
import { hashAuditIp, recordSecretAudit } from "../secrets/secret-audit.js";
import { isSameOriginRequest, sameOriginRefusal } from "../security/same-origin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import {
  deleteProjectSecret,
  importProjectSecrets,
  isProjectSecretFile,
  listProjectSecrets,
  PROJECT_SECRET_NAME,
  PROJECT_SECRETS_FILE,
  saveProjectSecrets,
  writeProjectSecret,
  type ProjectSecret,
} from "../secrets/project-secrets.js";

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
const valueSchema = z.object({
  requestId: z.string().min(1).max(100),
  value: z.string().min(1).max(20_000),
});
const cancelSchema = z.object({ id: z.string().min(1).max(200), requestId: z.string().min(1).max(100) });
const projectSecretSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(128).regex(PROJECT_SECRET_NAME, "Некорректное имя переменной"),
});
const secretFileSchema = z.string().max(120).refine(isProjectSecretFile, "Некорректное имя файла секретов").optional();
const saveProjectSecretsSchema = z.object({
  variables: z.record(z.string().max(128), z.string().max(20_000)).optional(),
  env: z.string().max(500_000).optional(),
  file: secretFileSchema,
}).refine(body => Boolean(body.env?.trim() || Object.keys(body.variables ?? {}).length), {
  message: "Пустой запрос: нет ни переменных, ни файла .env",
});
const deleteQuerySchema = z.object({ file: secretFileSchema });

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
  writeSecret: (projectId: string, root: string, file: string, variable: string, value: string) => Promise<ProjectSecret[]>;
  listSecrets: (projectId: string, root: string) => Promise<ProjectSecret[]>;
  saveSecrets: (projectId: string, root: string, variables: Record<string, string>, file?: string) => Promise<ProjectSecret[]>;
  importSecrets: (projectId: string, root: string, env: string, file?: string) => Promise<ProjectSecret[]>;
  removeSecret: (projectId: string, root: string, name: string, file?: string) => Promise<{ deleted: boolean; variables: ProjectSecret[] }>;
};

const defaultDeps: SecretRouteDeps = {
  authorize: (request, reply) => requireUser(request, reply),
  getProject: async id => {
    const project = await getProject(id);
    return project ? { id: project.id, userId: project.userId } : null;
  },
  getSandboxRoot: async (projectId, userId) => (await getSandbox(projectId, userId)).root,
  findRequest: findSecretRequest,
  resolveRequest: resolveSecretRequest,
  writeSecret: writeProjectSecret,
  listSecrets: listProjectSecrets,
  saveSecrets: saveProjectSecrets,
  importSecrets: importProjectSecrets,
  removeSecret: deleteProjectSecret,
};

function projectNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Проект не найден" });
}

/**
 * Каждый ответ о секретах — `no-store` и только со своего источника. Это одна функция на все
 * методы: иначе новый маршрут легко забывает одну из двух защит.
 */
function guardSecretRequest(request: FastifyRequest, reply: FastifyReply): boolean {
  applyNoStoreToReply(reply);
  if (!isSameOriginRequest(request)) {
    void reply.code(403).send({ error: sameOriginRefusal() });
    return false;
  }
  return true;
}

async function audit(
  request: FastifyRequest,
  projectId: string,
  userId: string,
  action: "write" | "import" | "delete" | "request" | "cancel",
  names: string[],
  file = PROJECT_SECRETS_FILE,
) {
  await recordSecretAudit({
    projectId,
    userId,
    action,
    names,
    file,
    ipHash: hashAuditIp(request.ip),
  });
}

/**
 * Значение ключа идёт единственным путём: из модального окна в браузере в зашифрованное хранилище
 * секретов проекта. Оно не возвращается в ответе, не пишется в переписку и не попадает в события
 * запуска — агент получает только подтверждение, что переменная сохранена. Именно поэтому маршрут
 * живёт отдельно от сокета агента: тот разговор о задаче, а этот — о секрете.
 */
export async function registerSecretRoutes(app: FastifyInstance, overrides: Partial<SecretRouteDeps> = {}) {
  const deps: SecretRouteDeps = { ...defaultDeps, ...overrides };

  /** Список переменных проекта: только имена и форма значения, сам секрет в браузер не уходит. */
  app.get("/api/projects/:id/secrets", async (request, reply) => {
    if (!guardSecretRequest(request, reply)) return;
    const user = await deps.authorize(request, reply); if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const project = await deps.getProject(id);
    if (!project || project.userId !== user.id) return projectNotFound(reply);
    const root = await deps.getSandboxRoot(project.id, user.id);
    return { file: PROJECT_SECRETS_FILE, variables: await deps.listSecrets(project.id, root) };
  });

  /** Добавление, замена и массовый импорт .env. Значение пишется в хранилище и не возвращается. */
  app.put("/api/projects/:id/secrets", async (request, reply) => {
    if (!guardSecretRequest(request, reply)) return;
    const user = await deps.authorize(request, reply); if (!user) return;
    const { id } = paramsSchema.parse(request.params);
    const body = saveProjectSecretsSchema.parse(request.body ?? {});
    const project = await deps.getProject(id);
    if (!project || project.userId !== user.id) return projectNotFound(reply);
    const root = await deps.getSandboxRoot(project.id, user.id);
    const file = body.file ?? PROJECT_SECRETS_FILE;
    try {
      let variables: ProjectSecret[] | undefined;
      if (body.env?.trim()) variables = await deps.importSecrets(project.id, root, body.env, file);
      // Поля применяются после файла: осознанная правка конкретной переменной побеждает импорт.
      if (body.variables && Object.keys(body.variables).length) variables = await deps.saveSecrets(project.id, root, body.variables, file);

      // В журнал — только имена. Значения уже записаны в файл и сюда не передаются.
      let importedNames: string[] = [];
      if (body.env?.trim()) {
        try { importedNames = parseEnvFileContent(body.env).map(entry => entry.name); } catch { /* импорт уже проверил файл */ }
      }
      const explicitNames = Object.keys(body.variables ?? {});
      await audit(
        request,
        project.id,
        user.id,
        importedNames.length && !explicitNames.length ? "import" : "write",
        [...importedNames, ...explicitNames],
        file,
      );
      return { file, variables: variables ?? await deps.listSecrets(project.id, root) };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось сохранить секрет" });
    }
  });

  app.delete("/api/projects/:id/secrets/:name", async (request, reply) => {
    if (!guardSecretRequest(request, reply)) return;
    const user = await deps.authorize(request, reply); if (!user) return;
    const { id, name } = projectSecretSchema.parse(request.params);
    const project = await deps.getProject(id);
    if (!project || project.userId !== user.id) return projectNotFound(reply);
    const root = await deps.getSandboxRoot(project.id, user.id);
    const file = deleteQuerySchema.parse(request.query ?? {}).file ?? PROJECT_SECRETS_FILE;
    try {
      const removed = await deps.removeSecret(project.id, root, name, file);
      await audit(request, project.id, user.id, "delete", [name], file);
      return { file, ...removed };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Не удалось удалить секрет" });
    }
  });

  app.post("/api/projects/:id/secrets", async (request, reply) => {
    if (!guardSecretRequest(request, reply)) return;
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
    await deps.writeSecret(project.id, root, pending.file, pending.variable, body.value);
    await audit(request, project.id, user.id, "request", [pending.variable], pending.file);

    // Инструмент продолжает работу только после этой строки: пока файл не записан, агент ждёт.
    const delivered = deps.resolveRequest(pending.id, { ok: true, variable: pending.variable, file: pending.file });
    return { ok: true, variable: pending.variable, file: pending.file, delivered };
  });

  app.post("/api/projects/:id/secrets/:requestId/cancel", async (request, reply) => {
    if (!guardSecretRequest(request, reply)) return;
    const user = await deps.authorize(request, reply); if (!user) return;
    const { id, requestId } = cancelSchema.parse(request.params);
    const project = await deps.getProject(id);
    if (!project || project.userId !== user.id) return reply.code(404).send({ error: "Проект не найден" });
    const pending = deps.findRequest(requestId);
    if (!pending || pending.projectId !== project.id || pending.userId !== user.id) {
      return reply.code(404).send({ error: "Запрос ключа уже неактуален" });
    }
    deps.resolveRequest(pending.id, { ok: false, cancelled: true });
    await audit(request, project.id, user.id, "cancel", [pending.variable], pending.file);
    return { cancelled: true };
  });
}
