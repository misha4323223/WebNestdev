import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getProject } from "../project-store.js";
import { nodeId } from "../nodes/identity.js";
import { getUser } from "../auth/auth-store.js";
import { sandboxRootPath } from "../sandbox/config.js";
import { listProjectSecrets } from "../secrets/project-secrets.js";
import { readDeployPlan } from "../deploy/deploy-plan.js";
import { previewStatus } from "../preview-manager.js";
import { hydratePreview } from "../preview/preview-store.js";
import { isRunActiveAnywhere } from "../agent/run-activity.js";
import { projectArchiveInfo, startProjectRestore } from "../storage/project-archive.js";
import { recordArchiveFailure } from "../storage/archive-health.js";
import { enqueueJob, jobCounters, listJobs, type JobKind, type JobState } from "../jobs/store.js";
import { recordAudit, type AuditInput } from "../security/audit-journal.js";

/**
 * Карточка проекта для админки.
 *
 * Раньше проект в админке был одной строкой с токенами: имя, владелец, дата. По ней нельзя было
 * ответить на вопрос, с которым приходит человек, — «превью не открывается», «куда он это
 * выкатывает», «почему сборка падает». Здесь собрано то, что уже есть на сервере, без новых
 * хранилищ: репозиторий из записи проекта, состояние превью из менеджера, переменные из секретов
 * проекта и последний план выкатки из `deploy_project.md` в песочнице.
 *
 * Значений секретов в ответе нет и быть не может: `listProjectSecrets` отдаёт имя, файл и форму
 * значения («скрыто · 3 строки»), а не само значение — тот же инвариант, что у панели.
 *
 * Только чтение: админка смотрит, а действия над проектами остаются за владельцем и агентом.
 * Исключение — холодный ярус: его двигает оператор (см. ниже), потому что «проект не открывается»
 * и «диск кончается сейчас» разбираются без ожидания трёх часов простоя и без захода на ВМ.
 */

const paramsSchema = z.object({ id: z.string().min(1).max(200) });

/**
 * Зависимости холодного яруса, вынесенные параметром: тест проверяет маршрут без настоящего бакета,
 * а прод берёт те же функции, что и пользовательские ручки.
 */
export type AdminArchiveDeps = {
  /** Есть ли уже архив: тогда очередь не нужна, отвечаем сразу с размером. */
  archiveInfo: (projectId: string, userId: string) => Promise<{ bytes: number } | null>;
  /**
   * Поставить архивацию в очередь. Раньше здесь был прямой вызов `archiveProject`, и запрос
   * держался всё время `tar` и загрузки в бакет — на проекте в 200 МБ это минуты, а на медленном
   * бакете легко упиралось в таймаут прокси.
   */
  enqueue: (projectId: string, userId: string) => Promise<{ id: string; state: string }>;
  restore: (projectId: string, userId: string) => Promise<{ id: string; bytesDone: number; bytesTotal: number } | null>;
  audit: (input: AuditInput) => Promise<unknown>;
};

const archiveDeps: AdminArchiveDeps = {
  archiveInfo: (projectId, userId) => projectArchiveInfo(projectId, userId),
  enqueue: (projectId, userId) => enqueueJob({ kind: "project.archive", projectId, userId }),
  restore: (projectId, userId) => startProjectRestore(projectId, userId),
  audit: input => recordAudit(input),
};

export async function registerAdminProjectRoutes(
  app: FastifyInstance,
  overrides: Partial<AdminArchiveDeps> = {},
) {
  const deps: AdminArchiveDeps = { ...archiveDeps, ...overrides };
  app.get("/api/admin/projects/:id", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { id } = paramsSchema.parse(request.params);
    const project = await getProject(id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });

    const root = sandboxRootPath(project.id);
    const [owner, secrets, preview] = await Promise.all([
      getUser(project.userId),
      // Проект мог быть создан до появления секретов или песочница могла быть удалена:
      // отсутствие файлов не должно превращать карточку в ошибку.
      listProjectSecrets(project.id, root).catch(() => []),
      previewStatus(project.id).catch(() => ({ running: false as const })),
    ]);

    let deploy: unknown = null;
    try {
      deploy = await readDeployPlan(root);
    } catch (error) {
      deploy = { exists: false, error: error instanceof Error ? error.message : String(error) };
    }

    return {
      project: {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        node: project.node ?? nodeId(),
        repository: project.github ?? null,
      },
      owner: owner ? { id: owner.id, email: owner.email, createdAt: owner.createdAt } : { id: project.userId, email: null, createdAt: null },
      preview: {
        ...preview,
        /** Причина, по которой живое превью не отвечает, — ровно то, что нужно для разбора. */
        error: preview.running ? preview.hint ?? null : null,
      },
      secrets: {
        count: secrets.length,
        variables: secrets.map(secret => ({ name: secret.name, file: secret.file, preview: secret.preview })),
      },
      deploy,
    };
  });

  /**
   * Уложить проект в холодный ярус немедленно. Нужно в двух случаях: диск кончается сейчас,
   * а ждать трёх часов простоя нельзя, и разбор «проект не открывается» — оператору надо увидеть,
   * что объект в бакете есть и его размер совпадает. Рабочая папка удаляется только после
   * подтверждения размера хранилищем (см. `archiveProject`), так что неудачная попытка
   * оставляет проект на диске.
   */
  app.post("/api/admin/projects/:id/archive", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    const { id } = paramsSchema.parse(request.params);
    const project = await getProject(id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });
    // Те же два ограничения, что у пользовательской ручки: иначе tar читает файлы, которые
    // прямо сейчас пишет агент, или которые держит открытыми превью.
    if (await isRunActiveAnywhere(id)) {
      return reply.code(409).send({ error: "Агент ещё работает в проекте — дождитесь окончания запуска", code: "PROJECT_BUSY" });
    }
    if (await hydratePreview(id)) {
      return reply.code(409).send({ error: "Остановите предпросмотр: он держит файлы проекта открытыми", code: "PREVIEW_RUNNING" });
    }
    try {
      const existing = await deps.archiveInfo(id, project.userId);
      if (existing) {
        await deps.audit({
          action: "admin.project.archived",
          actorType: "admin",
          actorId: auth.admin.id,
          actorLabel: auth.admin.email,
          target: id,
          targetLabel: project.name,
          details: { bytes: existing.bytes, alreadyArchived: true },
        });
        return { archived: true, bytes: existing.bytes, alreadyArchived: true };
      }
      const job = await deps.enqueue(id, project.userId);
      await deps.audit({
        action: "admin.project.archived",
        actorType: "admin",
        actorId: auth.admin.id,
        actorLabel: auth.admin.email,
        target: id,
        targetLabel: project.name,
        details: { jobId: job.id, queued: true },
      });
      console.log(
        "[admin] проект " + id + ": архивация поставлена в очередь (задание " + job.id + ")",
      );
      // 202: работа принята, но не сделана. Размер архива появится в задании
      // (`GET /api/admin/jobs`), а панель проекта увидит его в карточке холодного яруса.
      return reply.code(202).send({ archived: false, queued: true, jobId: job.id, state: job.state });
    } catch (error) {
      // Ошибка операторской архивации — такая же ошибка архивации: она должна попасть в счётчик
      // алертов, иначе «диск полный, уложить не удалось» останется только в логе.
      recordArchiveFailure();
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message, code: "ARCHIVE_FAILED" });
    }
  });

  /**
   * Вернуть проект из бакета на диск. Отвечает `202` и `jobId`, как пользовательская ручка:
   * распаковка 200 МБ не держит HTTP-запрос. Проект без отметки архива — не ошибка,
   * а `{archived:false, restored:false}`.
   */
  app.post("/api/admin/projects/:id/restore", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    const { id } = paramsSchema.parse(request.params);
    const project = await getProject(id);
    if (!project) return reply.code(404).send({ error: "Проект не найден" });
    try {
      const job = await deps.restore(id, project.userId);
      if (!job) return { archived: false, restored: false, restoring: false, jobId: null };
      await deps.audit({
        action: "admin.project.restored",
        actorType: "admin",
        actorId: auth.admin.id,
        actorLabel: auth.admin.email,
        target: id,
        targetLabel: project.name,
        details: { jobId: job.id, bytesTotal: job.bytesTotal },
      });
      console.log("[admin] проект " + id + ": оператор вернул из холодного яруса в работу");
      return reply.code(202).send({
        archived: true,
        restored: false,
        restoring: true,
        jobId: job.id,
        bytesDone: job.bytesDone,
        bytesTotal: job.bytesTotal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: message, code: "RESTORE_FAILED" });
    }
  });

  /**
   * Очередь долгих заданий: что ждёт, что выполняется, что упало и с какой ошибкой.
   * До этой ручки состояние архивации/восстановления можно было увидеть только по строкам в логе.
   * Фильтры повторяют то, что нужно при разборе: по состоянию, по виду и по проекту.
   */
  app.get("/api/admin/jobs", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    const query = jobsQuerySchema.parse(request.query ?? {});
    const [jobs, counters] = await Promise.all([
      listJobs({
        ...(query.state ? { state: query.state as JobState } : {}),
        ...(query.kind ? { kind: query.kind as JobKind } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        limit: query.limit,
      }),
      jobCounters(),
    ]);
    return { jobs, counters };
  });
}

const jobsQuerySchema = z.object({
  state: z.enum(["queued", "running", "done", "failed"]).optional(),
  kind: z.enum(["project.archive", "project.restore"]).optional(),
  projectId: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
