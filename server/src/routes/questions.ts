import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { getProject } from "../project-store.js";
import { findPendingQuestion, resolvePendingQuestion, type PendingQuestion, type QuestionResolution } from "../questions/pending-questions.js";

const paramsSchema = z.object({ id: z.string().min(1).max(200), requestId: z.string().min(1).max(100) });
const answerSchema = z.object({
  selected: z.array(z.string().trim().max(120)).max(8).optional(),
  custom: z.string().trim().max(2_000).optional(),
});

/**
 * Всё, что трогает маршрут, вынесено в зависимости — так тест проходит весь путь (выбор варианта,
 * свой ответ, пропуск, чужой проект) без базы, песочницы и живого запуска агента.
 */
export type QuestionRouteDeps = {
  authorize: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string } | null>;
  getProject: (id: string) => Promise<{ id: string; userId: string } | null>;
  findQuestion: (id: string) => PendingQuestion | null;
  resolveQuestion: (id: string, resolution: QuestionResolution) => boolean;
};

const defaultDeps: QuestionRouteDeps = {
  authorize: (request, reply) => requireUser(request, reply),
  getProject: async id => {
    const project = await getProject(id);
    return project ? { id: project.id, userId: project.userId } : null;
  },
  findQuestion: findPendingQuestion,
  resolveQuestion: resolvePendingQuestion,
};

/**
 * Ответ на вопрос агента. Отдельный маршрут, а не сообщение в сокет: пока агент ждёт, запуск уже
 * открыт, и второй «разговор» по тому же сокету смешался бы с потоком задачи.
 *
 * Сервер сам сверяет ответ с вопросом: выбрать можно только предложенные варианты, несколько —
 * только если вопрос это разрешает, а свой текст — только когда окно его предлагает. Иначе модель
 * получила бы ответ, которого пользователь не давал.
 */
export async function registerQuestionRoutes(app: FastifyInstance, overrides: Partial<QuestionRouteDeps> = {}) {
  const deps: QuestionRouteDeps = { ...defaultDeps, ...overrides };

  /** Общая проверка: проект принадлежит пользователю, а вопрос — этому проекту. */
  async function pendingFor(request: FastifyRequest, reply: FastifyReply) {
    const user = await deps.authorize(request, reply); if (!user) return null;
    const params = paramsSchema.parse(request.params);
    const project = await deps.getProject(params.id);
    if (!project || project.userId !== user.id) { reply.code(404).send({ error: "Проект не найден" }); return null; }
    const pending = deps.findQuestion(params.requestId);
    // Чужой вопрос не отличается от истёкшего: и то и другое — «окно устарело».
    if (!pending || pending.projectId !== project.id || pending.userId !== user.id) {
      reply.code(404).send({ error: "Вопрос устарел — агент уже не ждёт ответа" });
      return null;
    }
    return pending;
  }

  app.post("/api/projects/:id/questions/:requestId/answer", async (request, reply) => {
    const pending = await pendingFor(request, reply); if (!pending) return;
    const body = answerSchema.parse(request.body ?? {});
    const selected = body.selected ?? [];
    const custom = body.custom ?? "";

    if (!selected.length && !custom) return reply.code(400).send({ error: "Выберите вариант или напишите свой" });
    const allowed = new Set(pending.options.map(option => option.label));
    const unknown = selected.find(label => !allowed.has(label));
    if (unknown) return reply.code(400).send({ error: "Такого варианта в вопросе нет: " + unknown });
    if (!pending.multiSelect && selected.length > 1) return reply.code(400).send({ error: "В этом вопросе можно выбрать только один вариант" });
    if (custom && !pending.allowCustom) return reply.code(400).send({ error: "Свой ответ в этом вопросе не предусмотрен" });
    // Свой текст, совпавший с вариантом, — это тот же вариант, а не второй ответ.
    const customText = custom && !allowed.has(custom) ? custom : "";

    const resolution: QuestionResolution = {
      ok: true,
      selected,
      ...(customText ? { custom: customText } : {}),
    };
    const delivered = deps.resolveQuestion(pending.id, resolution);
    return { ok: true, selected, ...(customText ? { custom: customText } : {}), delivered };
  });

  app.post("/api/projects/:id/questions/:requestId/skip", async (request, reply) => {
    const pending = await pendingFor(request, reply); if (!pending) return;
    deps.resolveQuestion(pending.id, { ok: false, cancelled: true });
    return { cancelled: true };
  });
}
