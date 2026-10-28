import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { getTable, ydbQuery } from "../storage/ydb.js";
import { getUserProfile } from "../account/profile-store.js";
import { accountPlanFor, getSubscriptionRecord, isSubscriptionLive } from "../billing/store.js";

/**
 * Статистика платформы для админ-приложения: обзор, ряд по дням, модели, пользователи, проекты.
 *
 * Только чтение и только существующие таблицы. Источник расхода — `model_usage`: в ней лежат
 * модель, токены, проект и пользователь, поэтому «сколько потратил клиент» и «какая модель»
 * считаются из одного места, а не из догадок. Новых таблиц нет — на этих данных уже работает
 * биллинг (account/usage-store.ts).
 *
 * Пароля, TOTP-секретов, кодов восстановления и содержимого диалогов здесь нет: админка показывает
 * метрики, а не чужой код.
 *
 * Числа: node-postgres отдаёт `BIGINT` и `numeric` строками (чтобы не терять точность), поэтому
 * каждое значение проходит через num(). Даты во всех таблицах — TEXT в ISO-виде, поэтому сравнение
 * `usage_date >= '2026-10-19'` работает как сравнение дат, а `String(...)` не превращает Date в
 * нечитаемую строку.
 */

const T = (name: string) => ydbQuery().identifier(getTable(name));

const daysSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) });
const usersSchema = z.object({
  query: z.string().trim().max(200).optional(),
  sort: z.enum(["tokens", "projects", "created"]).default("tokens"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  days: z.coerce.number().int().min(0).max(365).default(0),
});
const projectsSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  days: z.coerce.number().int().min(0).max(365).default(0),
});

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Первый день окна из `days` дней, включая сегодняшний: 7 → сегодня минус шесть. */
export function periodStart(days: number, from = new Date()): string {
  const start = new Date(from);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return isoDate(start);
}

/**
 * Предыдущее окно той же длины — для «было/стало».
 *
 * `periodStart(days, fromDate)` здесь не подходит: он отсчитывает от начала текущего окна, и
 * получалось бы на день короче. Поэтому конец предыдущего окна — день до начала текущего, а
 * начало — ровно `days` дней назад от него.
 */
export function previousPeriod(fromDate: string, days: number): { prevFrom: string; prevTo: string } {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const prevTo = new Date(start);
  prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(start);
  prevFrom.setUTCDate(prevFrom.getUTCDate() - days);
  return { prevFrom: isoDate(prevFrom), prevTo: isoDate(prevTo) };
}

export type DayPoint = { date: string; prompt: number; completion: number; runs: number };

/** Все дни периода, включая пустые: график не должен «склеивать» провал и показывать его как рост. */
export function fillDays(points: DayPoint[], days: number, to: string): DayPoint[] {
  const byDate = new Map(points.map(point => [point.date, point]));
  const out: DayPoint[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - offset);
    const key = isoDate(day);
    out.push(byDate.get(key) ?? { date: key, prompt: 0, completion: 0, runs: 0 });
  }
  return out;
}

type SeriesRow = { usage_date: string; prompt: unknown; completion: unknown; runs: unknown };

// Два отдельных запроса вместо склейки условия: tagged-шаблон подставляет значения параметрами,
// и «кусок SQL» через него не передать.
async function seriesFor(fromDate: string, userId?: string): Promise<DayPoint[]> {
  const [rows] = userId
    ? await ydbQuery()<Array<SeriesRow>>`
        SELECT usage_date, COALESCE(SUM(prompt_tokens), 0) AS prompt,
               COALESCE(SUM(completion_tokens), 0) AS completion, COUNT(*) AS runs
        FROM ${T("model_usage")}
        WHERE usage_date >= ${fromDate} AND user_id = ${userId}
        GROUP BY usage_date ORDER BY usage_date
      `
    : await ydbQuery()<Array<SeriesRow>>`
        SELECT usage_date, COALESCE(SUM(prompt_tokens), 0) AS prompt,
               COALESCE(SUM(completion_tokens), 0) AS completion, COUNT(*) AS runs
        FROM ${T("model_usage")}
        WHERE usage_date >= ${fromDate}
        GROUP BY usage_date ORDER BY usage_date
      `;
  return rows.map(row => ({
    date: String(row.usage_date).slice(0, 10),
    prompt: num(row.prompt),
    completion: num(row.completion),
    runs: num(row.runs),
  }));
}

async function tokenTotals(fromDate: string) {
  const [rows] = await ydbQuery()<Array<{ prompt: unknown; completion: unknown; runs: unknown; users: unknown }>>`
    SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
           COALESCE(SUM(completion_tokens), 0) AS completion,
           COUNT(*) AS runs,
           COUNT(DISTINCT user_id) AS users
    FROM ${T("model_usage")}
    WHERE usage_date >= ${fromDate}
  `;
  const row = rows[0] ?? {};
  return { prompt: num(row.prompt), completion: num(row.completion), runs: num(row.runs), users: num(row.users) };
}

type ModelRow = { model: string; prompt: unknown; completion: unknown; runs: unknown; users: unknown };

type ModelStat = {
  model: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  users: number;
  share: number;
};

async function modelStats(fromDate: string, userId?: string): Promise<ModelStat[]> {
  const [rows] = userId
    ? await ydbQuery()<Array<ModelRow>>`
        SELECT model, COALESCE(SUM(prompt_tokens), 0) AS prompt,
               COALESCE(SUM(completion_tokens), 0) AS completion,
               COUNT(*) AS runs, COUNT(DISTINCT user_id) AS users
        FROM ${T("model_usage")}
        WHERE usage_date >= ${fromDate} AND user_id = ${userId}
        GROUP BY model
      `
    : await ydbQuery()<Array<ModelRow>>`
        SELECT model, COALESCE(SUM(prompt_tokens), 0) AS prompt,
               COALESCE(SUM(completion_tokens), 0) AS completion,
               COUNT(*) AS runs, COUNT(DISTINCT user_id) AS users
        FROM ${T("model_usage")}
        WHERE usage_date >= ${fromDate}
        GROUP BY model
      `;
  return rows.map(row => {
    const promptTokens = num(row.prompt);
    const completionTokens = num(row.completion);
    return {
      model: String(row.model),
      runs: num(row.runs),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      users: num(row.users),
      share: 0,
    };
  });
}

/** Доля каждой модели в общем расходе; при нуле расхода — нули, а не деление на ноль. */
function withShare(models: ModelStat[], total: number): ModelStat[] {
  return models
    .map(model => ({ ...model, share: total > 0 ? model.totalTokens / total : 0 }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export async function registerAdminAnalyticsRoutes(app: FastifyInstance) {
  /** Обзор: сколько людей, проектов, токенов и запусков за период и что было в предыдущем окне. */
  app.get("/api/admin/stats/overview", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { days } = daysSchema.parse(request.query);
    const to = isoDate(new Date());
    const fromDate = periodStart(days);
    const { prevFrom, prevTo } = previousPeriod(fromDate, days);

    const current = await tokenTotals(fromDate);
    const [prevRows] = await ydbQuery()<Array<{ prompt: unknown; completion: unknown; runs: unknown }>>`
      SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
             COALESCE(SUM(completion_tokens), 0) AS completion,
             COUNT(*) AS runs
      FROM ${T("model_usage")}
      WHERE usage_date >= ${prevFrom} AND usage_date <= ${prevTo}
    `;
    const prevRow = prevRows[0] ?? {};
    // null, а не 0: «до этого окна расхода не было» и «потратили ноль» — разные ответы, и процент
    // изменения во втором случае делил бы на ноль.
    const previousTotal = num(prevRow.runs) > 0 ? num(prevRow.prompt) + num(prevRow.completion) : null;

    const [countRows] = await ydbQuery()<Array<{
      users_total: unknown; users_new: unknown; projects_total: unknown; projects_new: unknown; models: unknown;
    }>>`
      SELECT (SELECT COUNT(*) FROM ${T("users")}) AS users_total,
             (SELECT COUNT(*) FROM ${T("users")} WHERE created_at >= ${fromDate}) AS users_new,
             (SELECT COUNT(*) FROM ${T("projects")}) AS projects_total,
             (SELECT COUNT(*) FROM ${T("projects")} WHERE created_at >= ${fromDate}) AS projects_new,
             (SELECT COUNT(DISTINCT model) FROM ${T("model_usage")} WHERE usage_date >= ${fromDate}) AS models
    `;
    const counts = countRows[0] ?? {};
    const total = current.prompt + current.completion;

    return {
      generatedAt: new Date().toISOString(),
      period: { days, from: fromDate, to },
      users: { total: num(counts.users_total), new: num(counts.users_new), active: current.users },
      projects: { total: num(counts.projects_total), new: num(counts.projects_new) },
      tokens: { total, prompt: current.prompt, completion: current.completion, previousTotal },
      runs: { total: current.runs, averageTokens: current.runs > 0 ? Math.round(total / current.runs) : 0 },
      models: num(counts.models),
    };
  });

  app.get("/api/admin/stats/series", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { days } = daysSchema.parse(request.query);
    const fromDate = periodStart(days);
    const points = await seriesFor(fromDate);
    return { points: fillDays(points, days, isoDate(new Date())) };
  });

  app.get("/api/admin/stats/models", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { days } = daysSchema.parse(request.query);
    const fromDate = periodStart(days);
    const models = await modelStats(fromDate);
    const total = models.reduce((sum, model) => sum + model.totalTokens, 0);
    return { models: withShare(models, total) };
  });

  /**
   * Список пользователей. Фильтр, сортировка и страница считаются в Postgres: иначе «всего 2000
   * пользователей» молча теряло бы остальных, а `total` переставал бы значить «сколько подходит
   * под фильтр». Расход за окно — из model_usage, счётчики проектов и диалогов — из своих таблиц.
   */
  app.get("/api/admin/users", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const query = usersSchema.parse(request.query);
    const usageFrom = query.days > 0 ? periodStart(query.days) : "0000-01-01";
    const needle = query.query ?? "";

    const [rows] = await ydbQuery()<Array<{
      id: string; email: string; created_at: string;
      prompt: unknown; completion: unknown; last_usage: string | null; last_project: string | null;
      projects: unknown; conversations: unknown;
    }>>`
      WITH usage AS (
        SELECT user_id,
               COALESCE(SUM(prompt_tokens), 0) AS prompt,
               COALESCE(SUM(completion_tokens), 0) AS completion,
               MAX(created_at) AS last_usage
        FROM ${T("model_usage")}
        WHERE usage_date >= ${usageFrom}
        GROUP BY user_id
      ),
      proj AS (
        SELECT user_id, COUNT(*) AS projects, MAX(updated_at) AS last_project
        FROM ${T("projects")}
        GROUP BY user_id
      ),
      conv AS (
        SELECT p.user_id AS user_id, COUNT(c.id) AS conversations
        FROM ${T("conversations")} c
        JOIN ${T("projects")} p ON p.id = c.project_id
        GROUP BY p.user_id
      )
      SELECT u.id, u.email, u.created_at,
             COALESCE(usage.prompt, 0) AS prompt,
             COALESCE(usage.completion, 0) AS completion,
             usage.last_usage, proj.last_project,
             COALESCE(proj.projects, 0) AS projects,
             COALESCE(conv.conversations, 0) AS conversations
      FROM ${T("users")} u
      LEFT JOIN usage ON usage.user_id = u.id
      LEFT JOIN proj ON proj.user_id = u.id
      LEFT JOIN conv ON conv.user_id = u.id
      WHERE (${needle} = ''
             OR strpos(lower(u.email), lower(${needle})) > 0
             OR strpos(lower(u.id), lower(${needle})) > 0)
      ORDER BY
        CASE WHEN ${query.sort} = 'projects' THEN COALESCE(proj.projects, 0) END DESC NULLS LAST,
        CASE WHEN ${query.sort} = 'tokens' THEN COALESCE(usage.prompt, 0) + COALESCE(usage.completion, 0) END DESC NULLS LAST,
        u.created_at DESC
      LIMIT ${query.limit} OFFSET ${query.offset}
    `;

    const [totalRows] = await ydbQuery()<Array<{ total: unknown }>>`
      SELECT COUNT(*) AS total FROM ${T("users")} u
      WHERE (${needle} = ''
             OR strpos(lower(u.email), lower(${needle})) > 0
             OR strpos(lower(u.id), lower(${needle})) > 0)
    `;

    return {
      total: num(totalRows[0]?.total),
      users: rows.map(row => ({
        id: String(row.id),
        email: String(row.email),
        createdAt: String(row.created_at),
        projects: num(row.projects),
        conversations: num(row.conversations),
        tokens: {
          prompt: num(row.prompt),
          completion: num(row.completion),
          total: num(row.prompt) + num(row.completion),
        },
        lastActiveAt: row.last_usage ? String(row.last_usage) : row.last_project ? String(row.last_project) : null,
      })),
    };
  });

  /** Карточка пользователя: его расход, проекты, любимые модели и ряд за 30 дней. */
  app.get("/api/admin/users/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const params = z.object({ id: z.string().min(1).max(100) }).parse(request.params);
    const [userRows] = await ydbQuery()<Array<{ id: string; email: string; created_at: string }>>`
      SELECT id, email, created_at FROM ${T("users")} WHERE id = ${params.id} LIMIT 1
    `;
    const found = userRows[0];
    if (!found) return reply.code(404).send({ error: "Пользователь не найден" });

    const [usageRows] = await ydbQuery()<Array<{ prompt: unknown; completion: unknown; last_usage: string | null }>>`
      SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
             COALESCE(SUM(completion_tokens), 0) AS completion,
             MAX(created_at) AS last_usage
      FROM ${T("model_usage")} WHERE user_id = ${params.id}
    `;
    const usage = usageRows[0] ?? {};

    // Счётчики считаются отдельно от списка проектов: список ограничен 100 строками, а «сколько
    // всего» должно оставаться верным и для аккаунта с большим числом проектов.
    const [totalsRows] = await ydbQuery()<Array<{ projects: unknown; conversations: unknown }>>`
      WITH mine AS (SELECT id FROM ${T("projects")} WHERE user_id = ${params.id})
      SELECT (SELECT COUNT(*) FROM mine) AS projects,
             (SELECT COUNT(*) FROM ${T("conversations")} c JOIN mine ON mine.id = c.project_id) AS conversations
    `;
    const totals = totalsRows[0] ?? {};

    const [projectRows] = await ydbQuery()<Array<{
      id: string; name: string; created_at: string; updated_at: string;
      tokens: unknown; conversations: unknown; last_run: string | null;
    }>>`
      WITH mine AS (
        SELECT id, name, created_at, updated_at
        FROM ${T("projects")} WHERE user_id = ${params.id}
      ),
      usage AS (
        SELECT m.project_id,
               SUM(m.prompt_tokens + m.completion_tokens) AS tokens,
               MAX(m.created_at) AS last_run
        FROM ${T("model_usage")} m
        JOIN mine ON mine.id = m.project_id
        GROUP BY m.project_id
      ),
      conv AS (
        SELECT c.project_id, COUNT(*) AS conversations
        FROM ${T("conversations")} c
        JOIN mine ON mine.id = c.project_id
        GROUP BY c.project_id
      )
      SELECT mine.id, mine.name, mine.created_at, mine.updated_at,
             COALESCE(usage.tokens, 0) AS tokens,
             COALESCE(conv.conversations, 0) AS conversations,
             usage.last_run
      FROM mine
      LEFT JOIN usage ON usage.project_id = mine.id
      LEFT JOIN conv ON conv.project_id = mine.id
      ORDER BY mine.updated_at DESC
      LIMIT 100
    `;

    const usageTotal = num(usage.prompt) + num(usage.completion);
    const topModels = withShare(await modelStats("0000-01-01", params.id), usageTotal).slice(0, 5);
    const series = fillDays(await seriesFor(periodStart(30), params.id), 30, isoDate(new Date()));
    // Контакты знакомства вместе с ответом «откуда узнали»: админке не нужен отдельный запрос,
    // а источник — единственное поле профиля, которое она читает ради аналитики.
    const profile = await getUserProfile(params.id).catch(() => null);
    // Тариф и его срок — часть карточки: без них строка «Тариф» пустая, а выдача на день
    // выглядит так же, как её отсутствие.
    const plan = await accountPlanFor(params.id);
    const subscription = await getSubscriptionRecord(params.id);
    const planUntil = subscription && isSubscriptionLive(subscription) ? subscription.renewsAt : null;

    return {
      plan,
      planUntil,
      user: {
        id: String(found.id),
        email: String(found.email),
        createdAt: String(found.created_at),
        projects: num(totals.projects),
        conversations: num(totals.conversations),
        tokens: { prompt: num(usage.prompt), completion: num(usage.completion), total: usageTotal },
        lastActiveAt: usage.last_usage ? String(usage.last_usage) : null,
        plan,
        planUntil,
        profile: profile ? {
          name: profile.name,
          email: profile.email,
          source: profile.source,
          newsletter: profile.newsletter,
          productUpdates: profile.productUpdates,
          completedAt: profile.completedAt,
          updatedAt: profile.updatedAt,
        } : null,
      },
      projects: projectRows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        userId: String(found.id),
        email: String(found.email),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        tokens: num(row.tokens),
        conversations: num(row.conversations),
        lastRunAt: row.last_run ? String(row.last_run) : null,
      })),
      topModels,
      series,
    };
  });

  /**
   * Проекты. Сначала страница (её считает Postgres по фильтру и сортировке), потом агрегаты только
   * по строкам этой страницы: коррелированные подзапросы в списке до LIMIT считались бы для всех
   * проектов сразу.
   */
  app.get("/api/admin/projects", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const query = projectsSchema.parse(request.query);
    const usageFrom = query.days > 0 ? periodStart(query.days) : "0000-01-01";
    const needle = query.query ?? "";

    const [rows] = await ydbQuery()<Array<{
      id: string; name: string; user_id: string; email: string;
      created_at: string; updated_at: string; tokens: unknown; conversations: unknown; last_run: string | null;
    }>>`
      WITH page AS (
        SELECT p.id
        FROM ${T("projects")} p
        LEFT JOIN ${T("users")} u ON u.id = p.user_id
        WHERE (${needle} = ''
               OR strpos(lower(p.name), lower(${needle})) > 0
               OR strpos(lower(p.id), lower(${needle})) > 0
               OR strpos(lower(u.email), lower(${needle})) > 0)
        ORDER BY p.updated_at DESC
        LIMIT ${query.limit} OFFSET ${query.offset}
      )
      SELECT p.id, p.name, p.user_id, COALESCE(u.email, '') AS email,
             p.created_at, p.updated_at,
             COALESCE((SELECT SUM(m.prompt_tokens + m.completion_tokens) FROM ${T("model_usage")} m
                       WHERE m.project_id = p.id AND m.usage_date >= ${usageFrom}), 0) AS tokens,
             (SELECT COUNT(*) FROM ${T("conversations")} c WHERE c.project_id = p.id) AS conversations,
             (SELECT MAX(m.created_at) FROM ${T("model_usage")} m
              WHERE m.project_id = p.id AND m.usage_date >= ${usageFrom}) AS last_run
      FROM ${T("projects")} p
      JOIN page ON page.id = p.id
      LEFT JOIN ${T("users")} u ON u.id = p.user_id
      ORDER BY p.updated_at DESC
    `;

    const [totalRows] = await ydbQuery()<Array<{ total: unknown }>>`
      SELECT COUNT(*) AS total
      FROM ${T("projects")} p
      LEFT JOIN ${T("users")} u ON u.id = p.user_id
      WHERE (${needle} = ''
             OR strpos(lower(p.name), lower(${needle})) > 0
             OR strpos(lower(p.id), lower(${needle})) > 0
             OR strpos(lower(u.email), lower(${needle})) > 0)
    `;

    return {
      total: num(totalRows[0]?.total),
      projects: rows.map(row => ({
        id: String(row.id),
        name: String(row.name),
        userId: String(row.user_id),
        email: String(row.email),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        tokens: num(row.tokens),
        conversations: num(row.conversations),
        lastRunAt: row.last_run ? String(row.last_run) : null,
      })),
    };
  });
}
