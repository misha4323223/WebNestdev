import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PLAN_CATALOG, type PlanId } from "../account/plans.js";
import { planPriceRub } from "../billing/robokassa.js";
import {
  costForTokens,
  isFreeModel,
  modelPriceFor,
  readInfraCostMonthly,
  readModelPriceTable,
  type ModelPriceTable,
} from "../account/model-pricing.js";
import { getFreeModelConfig } from "../provider/free-model.js";
import { getTable, ydbQuery } from "../storage/ydb.js";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { fillDays, isoDate, periodStart, type DayPoint } from "./admin-analytics.js";

/**
 * Деньги админки: сколько платформа тратит и сколько зарабатывает.
 *
 * Прежняя статистика считала токены — по ним видно нагрузку, но не видно, какая цена подписки
 * покрывает расход. Здесь два разреза:
 *
 * - `/stats/costs` — куда ушли деньги: по моделям, дням, пользователям, проектам и тарифам;
 * - `/stats/economics` — выручка против расхода, экономика каждого тарифа и цена, при которой
 *   подписка покрывает себестоимость с заданной маржой.
 *
 * Источники уже существуют: `model_usage` — токены и модель, `billing_payments` — фактически
 * оплаченные счёта, `billing_subscriptions` — действующие подписки. Новых таблиц нет.
 *
 * Деньги считаются в JS, а не в SQL: цены задаются таблицей `PLATFORM_AI_MODEL_PRICES`, и
 * подставлять её в каждый запрос значило бы собирать SQL из строк. Строк всего «модели × дни»
 * и «модели × тарифы», поэтому расчёт в памяти дешевле и не может разойтись с той же таблицей
 * цен в другом месте.
 *
 * Валюта расходов — `PLATFORM_AI_PRICE_CURRENCY`, выручка приходит в рублях. Если валюты
 * разные, маржа и рекомендации по цене не считаются (`null`): складывать доллары с рублями
 * нельзя, и честнее об этом сказать, чем показать красивую неверную сумму.
 */

const T = (name: string) => ydbQuery().identifier(getTable(name));
const REVENUE_CURRENCY = "RUB";

const costsSchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
const economicsSchema = costsSchema.extend({
  margin: z.coerce.number().min(0).max(0.9).default(0.7),
});

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toPlan(value: unknown): PlanId {
  return value === "pro" || value === "team" ? value : "free";
}

function planName(plan: PlanId): string {
  return PLAN_CATALOG[plan].name;
}

/** Инфраструктура в период: месячная сумма разложена по 30 дням, как и месячная оценка расхода. */
function infraForPeriod(monthly: number, days: number): number {
  return (monthly / 30) * days;
}

// ─── Источники ───────────────────────────────────────────────────────────────

type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  runs: number;
  users: number;
  projects: number;
  estimatedRuns: number;
};

async function usageTotals(fromDate: string): Promise<UsageTotals> {
  const [rows] = await ydbQuery()<Array<{
    prompt: unknown; completion: unknown; runs: unknown;
    users: unknown; projects: unknown; estimated: unknown;
  }>>`
    SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
           COALESCE(SUM(completion_tokens), 0) AS completion,
           COUNT(*) AS runs,
           COUNT(DISTINCT user_id) AS users,
           COUNT(DISTINCT project_id) AS projects,
           COALESCE(SUM(CASE WHEN estimated THEN 1 ELSE 0 END), 0) AS estimated
    FROM ${T("model_usage")}
    WHERE usage_date >= ${fromDate}
  `;
  const row = rows[0] ?? {};
  return {
    promptTokens: num(row.prompt),
    completionTokens: num(row.completion),
    runs: num(row.runs),
    users: num(row.users),
    projects: num(row.projects),
    estimatedRuns: num(row.estimated),
  };
}

type ModelRow = {
  model: string;
  prompt: unknown;
  completion: unknown;
  runs: unknown;
  users: unknown;
};

async function modelTotals(fromDate: string): Promise<ModelRow[]> {
  const [rows] = await ydbQuery()<ModelRow[]>`
    SELECT model,
           COALESCE(SUM(prompt_tokens), 0) AS prompt,
           COALESCE(SUM(completion_tokens), 0) AS completion,
           COUNT(*) AS runs,
           COUNT(DISTINCT user_id) AS users
    FROM ${T("model_usage")}
    WHERE usage_date >= ${fromDate}
    GROUP BY model
  `;
  return rows;
}

type DailyModelRow = {
  usage_date: string;
  model: string;
  prompt: unknown;
  completion: unknown;
  runs: unknown;
};

async function dailyModelRows(fromDate: string): Promise<DailyModelRow[]> {
  const [rows] = await ydbQuery()<DailyModelRow[]>`
    SELECT usage_date, model,
           COALESCE(SUM(prompt_tokens), 0) AS prompt,
           COALESCE(SUM(completion_tokens), 0) AS completion,
           COUNT(*) AS runs
    FROM ${T("model_usage")}
    WHERE usage_date >= ${fromDate}
    GROUP BY usage_date, model
    ORDER BY usage_date
  `;
  return rows;
}

type PlanModelRow = {
  plan: string;
  model: string;
  prompt: unknown;
  completion: unknown;
  runs: unknown;
};

type PlanUsersRow = { plan: string; users: unknown };

/**
 * Тариф считается по **текущей** подписке, а не по истории платежей: вопрос «сколько нам стоит
 * бесплатный тариф» относится к людям, у которых он сейчас. Просроченная подписка сразу
 * становится бесплатной — тем же правилом, что `accountPlanFor` в биллинге.
 */
async function planUsage(fromDate: string, nowIso: string): Promise<{
  rows: PlanModelRow[];
  users: Map<PlanId, number>;
}> {
  const [rows] = await ydbQuery()<PlanModelRow[]>`
    SELECT CASE
             WHEN s.user_id IS NOT NULL AND s.plan <> 'free' AND s.renews_at > ${nowIso}
               THEN s.plan
             ELSE 'free'
           END AS plan,
           m.model,
           COALESCE(SUM(m.prompt_tokens), 0) AS prompt,
           COALESCE(SUM(m.completion_tokens), 0) AS completion,
           COUNT(*) AS runs
    FROM ${T("model_usage")} m
    LEFT JOIN ${T("billing_subscriptions")} s ON s.user_id = m.user_id
    WHERE m.usage_date >= ${fromDate}
    GROUP BY 1, m.model
  `;

  const [userRows] = await ydbQuery()<PlanUsersRow[]>`
    SELECT CASE
             WHEN s.user_id IS NOT NULL AND s.plan <> 'free' AND s.renews_at > ${nowIso}
               THEN s.plan
             ELSE 'free'
           END AS plan,
           COUNT(DISTINCT m.user_id) AS users
    FROM ${T("model_usage")} m
    LEFT JOIN ${T("billing_subscriptions")} s ON s.user_id = m.user_id
    WHERE m.usage_date >= ${fromDate}
    GROUP BY 1
  `;

  const users = new Map<PlanId, number>();
  for (const row of userRows) users.set(toPlan(row.plan), num(row.users));
  return { rows, users };
}

// ─── Расчёт стоимости ────────────────────────────────────────────────────────

export type PricedModel = {
  model: string;
  runs: number;
  users: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number | null;
  priced: boolean;
  price: { input: number; output: number } | null;
  priceSource: string | null;
  tokenShare: number;
  costShare: number | null;
};

export type PricedModels = {
  models: PricedModel[];
  totalCost: number;
  totalTokens: number;
  unpriced: Array<{ model: string; tokens: number }>;
  complete: boolean;
};

/**
 * Токены → деньги по каждой модели. Модель без цены не превращается в ноль: её токены попадают
 * в `unpriced`, а `complete` становится `false` — иначе сумма выглядела бы полной, хотя часть
 * расхода в неё не вошла.
 */
export function priceModelRows(rows: ModelRow[], table: ModelPriceTable): PricedModels {
  const models = rows.map(row => {
    const promptTokens = num(row.prompt);
    const completionTokens = num(row.completion);
    const totalTokens = promptTokens + completionTokens;
    const resolved = modelPriceFor(String(row.model), table);
    const cost = resolved ? costForTokens(promptTokens, completionTokens, resolved.price) : null;
    return {
      model: String(row.model),
      runs: num(row.runs),
      users: num(row.users),
      promptTokens,
      completionTokens,
      totalTokens,
      cost,
      priced: resolved !== null,
      price: resolved ? resolved.price : null,
      priceSource: resolved ? resolved.rule.source : null,
      tokenShare: 0,
      costShare: null as number | null,
    };
  });

  const totalTokens = models.reduce((sum, model) => sum + model.totalTokens, 0);
  const totalCost = models.reduce((sum, model) => sum + (model.cost ?? 0), 0);
  const unpriced = models
    .filter(model => !model.priced && model.totalTokens > 0)
    .map(model => ({ model: model.model, tokens: model.totalTokens }));

  for (const model of models) {
    model.tokenShare = totalTokens > 0 ? model.totalTokens / totalTokens : 0;
    model.costShare = totalCost > 0 && model.cost !== null ? model.cost / totalCost : null;
  }
  models.sort((left, right) => {
    if (totalCost > 0) return (right.cost ?? 0) - (left.cost ?? 0);
    return right.totalTokens - left.totalTokens;
  });

  return { models, totalCost, totalTokens, unpriced, complete: unpriced.length === 0 };
}

export type PlanUsage = {
  plan: PlanId;
  name: string;
  activeUsers: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  runs: number;
  modelCost: number;
  costComplete: boolean;
  tokenShare: number;
  costShare: number | null;
};

/** Расход по тарифам — все три тарифа в ответе, даже если на одном из них ещё никого нет. */
export function planUsageStats(
  rows: PlanModelRow[],
  users: Map<PlanId, number>,
  table: ModelPriceTable,
  totalCost: number,
  totalTokens: number,
): PlanUsage[] {
  const byPlan = new Map<PlanId, {
    promptTokens: number;
    completionTokens: number;
    runs: number;
    modelCost: number;
    costComplete: boolean;
  }>();
  for (const plan of ["free", "pro", "team"] as PlanId[]) {
    byPlan.set(plan, { promptTokens: 0, completionTokens: 0, runs: 0, modelCost: 0, costComplete: true });
  }

  for (const row of rows) {
    const plan = toPlan(row.plan);
    const bucket = byPlan.get(plan)!;
    const promptTokens = num(row.prompt);
    const completionTokens = num(row.completion);
    bucket.promptTokens += promptTokens;
    bucket.completionTokens += completionTokens;
    bucket.runs += num(row.runs);
    const resolved = modelPriceFor(String(row.model), table);
    if (resolved) {
      bucket.modelCost += costForTokens(promptTokens, completionTokens, resolved.price);
    } else if (promptTokens + completionTokens > 0) {
      bucket.costComplete = false;
    }
  }

  return (["free", "pro", "team"] as PlanId[]).map(plan => {
    const bucket = byPlan.get(plan)!;
    const totalTokensForPlan = bucket.promptTokens + bucket.completionTokens;
    return {
      plan,
      name: planName(plan),
      activeUsers: users.get(plan) ?? 0,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      totalTokens: totalTokensForPlan,
      runs: bucket.runs,
      modelCost: bucket.modelCost,
      costComplete: bucket.costComplete,
      tokenShare: totalTokens > 0 ? totalTokensForPlan / totalTokens : 0,
      costShare: totalCost > 0 && bucket.modelCost > 0
        ? bucket.modelCost / totalCost
        : totalCost > 0
          ? 0
          : null,
    };
  });
}

export type Spender = {
  id: string;
  email: string;
  name?: string;
  tokens: number;
  runs: number;
  cost: number;
  costComplete: boolean;
};

type SpenderModelRow = {
  id: string;
  email: string;
  name?: string;
  model: string;
  prompt: unknown;
  completion: unknown;
  runs: unknown;
};

/** Строки «пользователь × модель» (или «проект × модель») → сумма по владельцу и деньги. */
export function spendersFromRows(rows: SpenderModelRow[], table: ModelPriceTable, limit = 10): Spender[] {
  const byId = new Map<string, Spender>();
  for (const row of rows) {
    const id = String(row.id);
    const current = byId.get(id) ?? {
      id,
      email: String(row.email ?? ""),
      ...(row.name === undefined ? {} : { name: String(row.name) }),
      tokens: 0,
      runs: 0,
      cost: 0,
      costComplete: true,
    };
    const promptTokens = num(row.prompt);
    const completionTokens = num(row.completion);
    current.tokens += promptTokens + completionTokens;
    current.runs += num(row.runs);
    const resolved = modelPriceFor(String(row.model), table);
    if (resolved) current.cost += costForTokens(promptTokens, completionTokens, resolved.price);
    else if (promptTokens + completionTokens > 0) current.costComplete = false;
    byId.set(id, current);
  }

  // Сортировка по токенам, а не по деньгам: у модели без цены стоимость неизвестна, и такой
  // потребитель с нулём в деньгах оказался бы внизу списка, хотя может тратить больше всех.
  // Деньги показаны рядом, а неполнота помечена `costComplete`.
  const spenders = [...byId.values()].sort((left, right) => {
    if (right.tokens !== left.tokens) return right.tokens - left.tokens;
    return right.cost - left.cost;
  });
  return spenders.slice(0, limit);
}

// ─── Цена подписки ───────────────────────────────────────────────────────────

export type PriceGuidanceInput = {
  targetMargin: number;
  /** Во сколько раз период короче месяца: 30 / days. */
  monthlyFactor: number;
  infraMonthly: number;
  /** Модельный расход бесплатного тарифа за период — его покрывают платящие. */
  freeModelCostPeriod: number;
  paidSubscribers: number;
  plans: Array<{ plan: PlanId; subscribers: number; modelCostPeriod: number }>;
};

export type PriceGuidance = {
  plan: PlanId;
  name: string;
  currentPriceRub: number;
  subscribers: number;
  modelCostPerSubscriberMonthly: number;
  infraPerSubscriberMonthly: number;
  freeSubsidyPerSubscriberMonthly: number;
  breakEvenPrice: number;
  suggestedPrice: number;
  marginAtCurrentPrice: number | null;
  coversCostAtCurrentPrice: boolean;
};

/**
 * Цена «по себестоимости» и цена под целевую маржу.
 *
 * В себестоимость подписчика входят три части: расход модели на его тарифе, его доля постоянной
 * инфраструктуры и доля расхода бесплатного тарифа. Последняя — не бухгалтерская придирка: если
 * бесплатные пользователи тратят платную модель, кто-то должен это оплатить, и обычно это
 * платящие. Число подписчиков берётся из действующих подписок, поэтому «ноль платящих» даёт
 * пустой список, а не деление на ноль.
 */
export function priceGuidance(input: PriceGuidanceInput): PriceGuidance[] {
  if (input.paidSubscribers <= 0) return [];
  const safeMargin = Math.min(0.9, Math.max(0, input.targetMargin));
  const infraPerSubscriber = input.infraMonthly / input.paidSubscribers;
  const freeSubsidy = (input.freeModelCostPeriod * input.monthlyFactor) / input.paidSubscribers;

  return input.plans
    .filter(plan => plan.plan !== "free" && plan.subscribers > 0)
    .map(plan => {
      const currentPriceRub = planPriceRub(plan.plan);
      const modelPerSubscriber = (plan.modelCostPeriod * input.monthlyFactor) / plan.subscribers;
      const breakEven = modelPerSubscriber + infraPerSubscriber + freeSubsidy;
      // Цена в рублях и «круглая»: 1 073 ₽ выглядит как ошибка, 1 080 ₽ — как цена.
      const suggested = breakEven > 0
        ? Math.ceil((breakEven / (1 - safeMargin)) / 10) * 10
        : 0;
      return {
        plan: plan.plan,
        name: planName(plan.plan),
        currentPriceRub,
        subscribers: plan.subscribers,
        modelCostPerSubscriberMonthly: roundMoney(modelPerSubscriber),
        infraPerSubscriberMonthly: roundMoney(infraPerSubscriber),
        freeSubsidyPerSubscriberMonthly: roundMoney(freeSubsidy),
        breakEvenPrice: roundMoney(breakEven),
        suggestedPrice: suggested,
        marginAtCurrentPrice: currentPriceRub > 0
          ? (currentPriceRub - breakEven) / currentPriceRub
          : null,
        coversCostAtCurrentPrice: currentPriceRub >= breakEven,
      };
    });
}

// ─── Предупреждения ─────────────────────────────────────────────────────────

export function costWarnings(input: {
  table: ModelPriceTable;
  unpriced: Array<{ model: string; tokens: number }>;
  infraConfigured: boolean;
  freeModelTokens: number;
  freeFallbackConfigured: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.table.invalidRules > 0) {
    warnings.push(
      "В PLATFORM_AI_MODEL_PRICES " + input.table.invalidRules +
      " некорректных записей — они пропущены.",
    );
  }
  if (!input.table.configured) {
    warnings.push(
      "Цены моделей не заданы: укажите PLATFORM_AI_MODEL_PRICES или PLATFORM_AI_PRICE_INPUT_PER_MILLION/OUTPUT_PER_MILLION. " +
      "Пока их нет, токены считаются, а деньги — нет.",
    );
  }
  if (input.unpriced.length > 0) {
    const list = input.unpriced
      .slice(0, 5)
      .map(model => model.model + " (" + model.tokens.toLocaleString("ru-RU") + " токенов)")
      .join(", ");
    warnings.push("Нет цены для моделей: " + list + " — их стоимость не вошла в сумму.");
  }
  if (input.freeModelTokens > 0 && input.freeFallbackConfigured) {
    warnings.push(
      "Запуски free-model посчитаны по нулю. Если бесплатные ключи недоступны, они уходят на платную модель — " +
      "фактическая стоимость может быть выше.",
    );
  }
  if (!input.infraConfigured) {
    warnings.push(
      "PLATFORM_INFRA_COST_PER_MONTH не задан: в расходе учтены только токены, без ВМ, диска и SMS.",
    );
  }
  return warnings;
}

// ─── Маршруты ───────────────────────────────────────────────────────────────

export async function registerAdminEconomicsRoutes(app: FastifyInstance) {
  /** Расходы: модели, дни, пользователи, проекты и тарифы. Только чтение. */
  app.get("/api/admin/stats/costs", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const { days } = costsSchema.parse(request.query);
    const table = readModelPriceTable();
    const infra = readInfraCostMonthly();
    const to = isoDate(new Date());
    const fromDate = periodStart(days);

    const [totals, modelRows, dailyRows, plan] = await Promise.all([
      usageTotals(fromDate),
      modelTotals(fromDate),
      dailyModelRows(fromDate),
      planUsage(fromDate, new Date().toISOString()),
    ]);

    const priced = priceModelRows(modelRows, table);
    const plans = planUsageStats(plan.rows, plan.users, table, priced.totalCost, priced.totalTokens);
    const infraCost = infraForPeriod(infra.monthly, days);
    const totalCost = priced.totalCost + infraCost;

    // Дневной ряд: токены и запуски — из `fillDays` (пустые дни остаются нулями), деньги —
    // по той же таблице цен, что и итог, поэтому сумма дней сходится с итогом периода.
    const dayTokens = new Map<string, DayPoint>();
    const dayCost = new Map<string, number>();
    for (const row of dailyRows) {
      const date = String(row.usage_date).slice(0, 10);
      const promptTokens = num(row.prompt);
      const completionTokens = num(row.completion);
      const point = dayTokens.get(date) ?? { date, prompt: 0, completion: 0, runs: 0 };
      point.prompt += promptTokens;
      point.completion += completionTokens;
      point.runs += num(row.runs);
      dayTokens.set(date, point);
      const resolved = modelPriceFor(String(row.model), table);
      if (resolved) {
        dayCost.set(date, (dayCost.get(date) ?? 0) + costForTokens(promptTokens, completionTokens, resolved.price));
      }
    }
    const daily = fillDays([...dayTokens.values()], days, to).map(point => {
      const modelCost = dayCost.get(point.date) ?? 0;
      return {
        date: point.date,
        promptTokens: point.prompt,
        completionTokens: point.completion,
        totalTokens: point.prompt + point.completion,
        runs: point.runs,
        modelCost: roundMoney(modelCost),
        infraCost: roundMoney(infra.monthly / 30),
        totalCost: roundMoney(modelCost + infra.monthly / 30),
      };
    });

    const [userRows] = await ydbQuery()<Array<{
      user_id: string; email: string; model: string;
      prompt: unknown; completion: unknown; runs: unknown;
    }>>`
      WITH agg AS (
        SELECT m.user_id, m.model,
               COALESCE(SUM(m.prompt_tokens), 0) AS prompt,
               COALESCE(SUM(m.completion_tokens), 0) AS completion,
               COUNT(*) AS runs
        FROM ${T("model_usage")} m
        WHERE m.usage_date >= ${fromDate}
        GROUP BY m.user_id, m.model
      ),
      top AS (
        SELECT user_id FROM agg
        GROUP BY user_id
        ORDER BY SUM(prompt + completion) DESC
        LIMIT 25
      )
      SELECT agg.user_id, COALESCE(u.email, '') AS email, agg.model, agg.prompt, agg.completion, agg.runs
      FROM agg
      JOIN top ON top.user_id = agg.user_id
      LEFT JOIN ${T("users")} u ON u.id = agg.user_id
    `;

    const [projectRows] = await ydbQuery()<Array<{
      project_id: string; name: string; email: string; model: string;
      prompt: unknown; completion: unknown; runs: unknown;
    }>>`
      WITH agg AS (
        SELECT m.project_id, m.model,
               COALESCE(SUM(m.prompt_tokens), 0) AS prompt,
               COALESCE(SUM(m.completion_tokens), 0) AS completion,
               COUNT(*) AS runs
        FROM ${T("model_usage")} m
        WHERE m.usage_date >= ${fromDate}
        GROUP BY m.project_id, m.model
      ),
      top AS (
        SELECT project_id FROM agg
        GROUP BY project_id
        ORDER BY SUM(prompt + completion) DESC
        LIMIT 25
      )
      SELECT agg.project_id, COALESCE(p.name, '') AS name, COALESCE(u.email, '') AS email,
             agg.model, agg.prompt, agg.completion, agg.runs
      FROM agg
      JOIN top ON top.project_id = agg.project_id
      LEFT JOIN ${T("projects")} p ON p.id = agg.project_id
      LEFT JOIN ${T("users")} u ON u.id = p.user_id
    `;

    const freeModelTokens = modelRows
      .filter(row => isFreeModel(String(row.model), table))
      .reduce((sum, row) => sum + num(row.prompt) + num(row.completion), 0);
    const freeFallback = Boolean(getFreeModelConfig()?.fallback);

    return {
      generatedAt: new Date().toISOString(),
      period: { days, from: fromDate, to },
      currency: table.currency,
      pricing: {
        configured: table.configured,
        source: table.source,
        invalidRules: table.invalidRules,
        models: table.rules.map(rule => ({ match: rule.match, input: rule.input, output: rule.output })),
        catchAll: table.catchAll
          ? { input: table.catchAll.input, output: table.catchAll.output, source: table.catchAll.source }
          : null,
        freeModels: table.freeMatches,
      },
      infra: {
        configured: infra.configured,
        monthly: roundMoney(infra.monthly),
        perDay: roundMoney(infra.monthly / 30),
        period: roundMoney(infraCost),
      },
      totals: {
        runs: totals.runs,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        totalTokens: totals.promptTokens + totals.completionTokens,
        projects: totals.projects,
        activeUsers: totals.users,
        estimatedRuns: totals.estimatedRuns,
        exactRuns: Math.max(0, totals.runs - totals.estimatedRuns),
        modelCost: roundMoney(priced.totalCost),
        infraCost: roundMoney(infraCost),
        totalCost: roundMoney(totalCost),
        costPerRun: totals.runs > 0 ? roundMoney(totalCost / totals.runs) : null,
        costPerProject: totals.projects > 0 ? roundMoney(totalCost / totals.projects) : null,
        costPerActiveUser: totals.users > 0 ? roundMoney(totalCost / totals.users) : null,
        complete: priced.complete,
      },
      daily,
      models: priced.models.map(model => ({
        ...model,
        cost: model.cost === null ? null : roundMoney(model.cost),
      })),
      plans,
      topUsers: spendersFromRows(
        userRows.map(row => ({
          id: row.user_id,
          email: row.email,
          model: row.model,
          prompt: row.prompt,
          completion: row.completion,
          runs: row.runs,
        })),
        table,
      ).map(user => ({ ...user, cost: roundMoney(user.cost) })),
      topProjects: spendersFromRows(
        projectRows.map(row => ({
          id: row.project_id,
          email: row.email,
          name: row.name,
          model: row.model,
          prompt: row.prompt,
          completion: row.completion,
          runs: row.runs,
        })),
        table,
      ).map(project => ({ ...project, cost: roundMoney(project.cost) })),
      warnings: costWarnings({
        table,
        unpriced: priced.unpriced,
        infraConfigured: infra.configured,
        freeModelTokens,
        freeFallbackConfigured: freeFallback,
      }),
    };
  });

  /**
   * Экономика подписки: выручка, расход, маржа, разрез по тарифам и цена под целевую маржу.
   * `margin` — доля выручки, которую хотим оставить после расходов (0…0.9, по умолчанию 70 %).
   */
  app.get("/api/admin/stats/economics", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const query = economicsSchema.parse(request.query);
    const table = readModelPriceTable();
    const infra = readInfraCostMonthly();
    const now = new Date();
    const nowIso = now.toISOString();
    const to = isoDate(now);
    const fromDate = periodStart(query.days);
    const fromIso = fromDate + "T00:00:00.000Z";
    const toExclusiveIso = isoDate(new Date(now.getTime() + 86_400_000)) + "T00:00:00.000Z";
    const monthlyFactor = 30 / query.days;

    const [totals, modelRows, plan, revenueResult, subscriptionResult, userResult] = await Promise.all([
      usageTotals(fromDate),
      modelTotals(fromDate),
      planUsage(fromDate, nowIso),
      ydbQuery()<Array<{ plan: string; amount: unknown; payments: unknown }>>`
        SELECT plan, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS payments
        FROM ${T("billing_payments")}
        WHERE status = 'paid' AND paid_at >= ${fromIso} AND paid_at < ${toExclusiveIso}
        GROUP BY plan
      `,
      ydbQuery()<Array<{ plan: string; total: unknown }>>`
        SELECT plan, COUNT(*) AS total
        FROM ${T("billing_subscriptions")}
        WHERE plan <> 'free' AND renews_at > ${nowIso}
        GROUP BY plan
      `,
      ydbQuery()<Array<{ total: unknown }>>`SELECT COUNT(*) AS total FROM ${T("users")}`,
    ]);

    // Запросы возвращают `[rows]`; разворачиваем один раз, чтобы ниже работать с обычным списком.
    const [revenueRows] = revenueResult;
    const [subscriptionRows] = subscriptionResult;
    const [userRows] = userResult;

    const revenueByPlan = new Map<PlanId, { amount: number; payments: number }>();
    for (const row of revenueRows) {
      const planId = toPlan(row.plan);
      const current = revenueByPlan.get(planId) ?? { amount: 0, payments: 0 };
      current.amount += num(row.amount);
      current.payments += num(row.payments);
      revenueByPlan.set(planId, current);
    }

    const subscribers = new Map<PlanId, number>();
    for (const row of subscriptionRows) subscribers.set(toPlan(row.plan), num(row.total));
    const paidSubscribers = [...subscribers.values()].reduce((sum, count) => sum + count, 0);
    const totalUsers = num(userRows[0]?.total);

    const priced = priceModelRows(modelRows, table);
    const plansUsage = planUsageStats(plan.rows, plan.users, table, priced.totalCost, priced.totalTokens);
    const infraCostPeriod = infraForPeriod(infra.monthly, query.days);
    const monthlyModelCost = priced.totalCost * monthlyFactor;
    const monthlyTotalCost = monthlyModelCost + infra.monthly;
    const paidInPeriod = [...revenueByPlan.values()].reduce((sum, planRow) => sum + planRow.amount, 0);
    const payments = [...revenueByPlan.values()].reduce((sum, planRow) => sum + planRow.payments, 0);
    // Цена берётся не из каталога, а из действующей настройки магазина: тариф могли поднять
    // в панели (`ROBOKASSA_PRICE_*`), и MRR по старой цене разошёлся бы с реальной выручкой.
    const mrr = (["free", "pro", "team"] as PlanId[])
      .reduce((sum, plan) => sum + (subscribers.get(plan) ?? 0) * planPriceRub(plan), 0);
    const comparable = table.currency === REVENUE_CURRENCY;
    const freePlanCostPeriod = plansUsage.find(row => row.plan === "free")?.modelCost ?? 0;

    const planEconomics = plansUsage.map(row => {
      const planSubscribers = subscribers.get(row.plan) ?? 0;
      const modelCostMonthly = row.modelCost * monthlyFactor;
      const infraShare = paidSubscribers > 0
        ? infra.monthly * (planSubscribers / paidSubscribers)
        : 0;
      const planMrr = planSubscribers * planPriceRub(row.plan);
      const marginMonthly = planMrr - modelCostMonthly - infraShare;
      const revenue = revenueByPlan.get(row.plan) ?? { amount: 0, payments: 0 };
      return {
        plan: row.plan,
        name: row.name,
        priceRub: planPriceRub(row.plan),
        subscribers: planSubscribers,
        activeUsers: row.activeUsers,
        tokens: row.totalTokens,
        runs: row.runs,
        modelCostPeriod: roundMoney(row.modelCost),
        modelCostMonthly: roundMoney(modelCostMonthly),
        infraShareMonthly: roundMoney(infraShare),
        monthlyCost: roundMoney(modelCostMonthly + infraShare),
        paidInPeriod: roundMoney(revenue.amount),
        payments: revenue.payments,
        mrr: roundMoney(planMrr),
        marginMonthly: roundMoney(marginMonthly),
        marginRate: planMrr > 0 ? marginMonthly / planMrr : null,
        costComplete: row.costComplete,
      };
    });

    const freeModelTokens = modelRows
      .filter(row => isFreeModel(String(row.model), table))
      .reduce((sum, row) => sum + num(row.prompt) + num(row.completion), 0);
    const freeFallback = Boolean(getFreeModelConfig()?.fallback);
    const warnings = costWarnings({
      table,
      unpriced: priced.unpriced,
      infraConfigured: infra.configured,
      freeModelTokens,
      freeFallbackConfigured: freeFallback,
    });
    if (!comparable) {
      warnings.push(
        "Расходы в " + table.currency + ", выручка в " + REVENUE_CURRENCY +
        ": маржа и рекомендации по цене не считаются. Задайте PLATFORM_AI_PRICE_CURRENCY=" +
        REVENUE_CURRENCY + " и цены в рублях.",
      );
    }
    if (paidSubscribers === 0) {
      warnings.push("Действующих платных подписок нет: цену подписки пока не из чего выводить.");
    }
    if (query.days < 14) {
      warnings.push("Период короче 14 дней: месячная оценка чувствительна к случайным запускам.");
    }
    if (!priced.complete) {
      warnings.push(
        "Стоимость неполная: рекомендация по цене не рассчитана, пока у всех моделей нет цены.",
      );
    }

    return {
      generatedAt: nowIso,
      period: { days: query.days, from: fromDate, to },
      currencies: { cost: table.currency, revenue: REVENUE_CURRENCY, comparable },
      revenue: {
        paidInPeriod: roundMoney(paidInPeriod),
        payments,
        mrr: roundMoney(mrr),
        subscribers: {
          pro: subscribers.get("pro") ?? 0,
          team: subscribers.get("team") ?? 0,
          total: paidSubscribers,
        },
      },
      users: {
        total: totalUsers,
        active: totals.users,
        paid: paidSubscribers,
        free: Math.max(0, totalUsers - paidSubscribers),
        conversion: totalUsers > 0 ? paidSubscribers / totalUsers : null,
      },
      costs: {
        period: {
          model: roundMoney(priced.totalCost),
          infra: roundMoney(infraCostPeriod),
          total: roundMoney(priced.totalCost + infraCostPeriod),
        },
        monthly: {
          model: roundMoney(monthlyModelCost),
          infra: roundMoney(infra.monthly),
          total: roundMoney(monthlyTotalCost),
        },
        complete: priced.complete,
        unpriced: priced.unpriced,
      },
      margin: {
        period: comparable ? roundMoney(paidInPeriod - (priced.totalCost + infraCostPeriod)) : null,
        monthly: comparable ? roundMoney(mrr - monthlyTotalCost) : null,
        monthlyRate: comparable && mrr > 0 ? (mrr - monthlyTotalCost) / mrr : null,
      },
      plans: planEconomics,
      unit: {
        targetMargin: query.margin,
        activeUsers: totals.users,
        paidSubscribers,
        modelCostPerActiveUserMonthly: totals.users > 0 ? roundMoney(monthlyModelCost / totals.users) : null,
        infraPerPaidUserMonthly: paidSubscribers > 0 ? roundMoney(infra.monthly / paidSubscribers) : null,
        freeSubsidyPerPaidUserMonthly: paidSubscribers > 0
          ? roundMoney((freePlanCostPeriod * monthlyFactor) / paidSubscribers)
          : null,
        costPerPaidUserMonthly: paidSubscribers > 0
          ? roundMoney(monthlyTotalCost / paidSubscribers)
          : null,
        revenuePerPaidUserMonthly: paidSubscribers > 0 ? roundMoney(mrr / paidSubscribers) : null,
        marginPerPaidUserMonthly: comparable && paidSubscribers > 0
          ? roundMoney((mrr - monthlyTotalCost) / paidSubscribers)
          : null,
      },
      priceGuidance: comparable && priced.complete
        ? priceGuidance({
            targetMargin: query.margin,
            monthlyFactor,
            infraMonthly: infra.monthly,
            freeModelCostPeriod: freePlanCostPeriod,
            paidSubscribers,
            plans: plansUsage
              .filter(row => row.plan !== "free")
              .map(row => ({
                plan: row.plan,
                subscribers: subscribers.get(row.plan) ?? 0,
                modelCostPeriod: row.modelCost,
              })),
          })
        : [],
      warnings,
    };
  });
}
