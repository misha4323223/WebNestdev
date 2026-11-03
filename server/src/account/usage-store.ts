import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { creditPoolFor, limitsForPlan, type PlanId, type UsageKind, type UsageSnapshot } from "./plans.js";
import { accountPlanFor } from "../billing/store.js";
import { tokenBonusFor } from "./token-bonus.js";
import { creditBalance, recordCreditConsumption } from "../billing/credit-store.js";

/**
 * Какая граница тарифа отвечает за каждый вид расхода. Таблица, а не тернарный оператор: новый вид
 * расхода добавляется одной строкой, и забыть его в одной из ветвей невозможно.
 */
const LIMIT_KEY: Record<UsageKind, "agentRunsPerDay" | "browserChecksPerDay" | "webSearchesPerDay"> = {
  agentRuns: "agentRunsPerDay",
  browserChecks: "browserChecksPerDay",
  webSearches: "webSearchesPerDay",
};

/** Что именно закончилось — эти фразы видит человек, когда лимит исчерпан. */
const LIMIT_MESSAGE: Record<UsageKind, string> = {
  agentRuns: "Достигнут дневной лимит запусков агента",
  browserChecks: "Достигнут дневной лимит браузерных проверок",
  webSearches: "Достигнут дневной лимит поисков в интернете",
};

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
type UsageEvent = { id: string; userId: string; date: string; kind: UsageKind; createdAt: string };
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const current = previous.then(() => gate);
  locks.set(key, current);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
async function writeJsonAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); }
  catch (error) { try { await unlink(temp); } catch {} throw error; }
}
function utcDay(now = new Date()) { return now.toISOString().slice(0, 10); }

export class UsageLimitError extends Error {
  readonly statusCode = 429;
  constructor(readonly kind: UsageKind, readonly limit: number, readonly used: number) {
    super(LIMIT_MESSAGE[kind]);
    this.name = "UsageLimitError";
  }
}

export async function getUsageSnapshot(userId: string, now = new Date()): Promise<UsageSnapshot> {
  const date = utcDay(now);
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{kind:string;used:number|string|bigint}>>`
      SELECT kind, used FROM ${ydbQuery().identifier(getTable("usage_counters"))}
      WHERE user_id = ${userId} AND usage_date = ${date}
    `;
    return {
      date,
      agentRuns: Number(rows.find(row => row.kind === "agentRuns")?.used ?? 0),
      browserChecks: Number(rows.find(row => row.kind === "browserChecks")?.used ?? 0),
      webSearches: Number(rows.find(row => row.kind === "webSearches")?.used ?? 0),
    };
  }
  const events = await readJson<UsageEvent[]>(path.join(root, "account", "usage", date + ".json"), []);
  const own = events.filter(event => event.userId === userId && event.date === date);
  return {
    date,
    agentRuns: own.filter(event => event.kind === "agentRuns").length,
    browserChecks: own.filter(event => event.kind === "browserChecks").length,
    webSearches: own.filter(event => event.kind === "webSearches").length,
  };
}

export async function consumeUsage(userId: string, kind: UsageKind, plan: PlanId, now = new Date()): Promise<UsageSnapshot> {
  const date = utcDay(now);
  // JSON mode shares a daily file, so serialize all writers. YDB mode serializes per account in this process.
  const lockKey = isYdbEnabled() ? userId + ":" + date : "json:" + date;
  return withLock(lockKey, async () => {
    const limit = limitsForPlan(plan)[LIMIT_KEY[kind]];
    const event: UsageEvent = { id: randomUUID(), userId, date, kind, createdAt: now.toISOString() };
    if (isYdbEnabled()) {
      // Serializable read-write transaction: competing reservations conflict on the same counter key.
      // The SDK retries retryable conflicts, so every replica observes the committed counter value.
      const sql = ydbQuery();
      const usageCountersTable = sql.identifier(getTable("usage_counters"));
      const usageEventsTable = sql.identifier(getTable("usage_events"));
      await sql.transaction({ idempotent: true }, async tx => {
        const [rows] = await tx<Array<{used:number|string|bigint}>>`
          SELECT used FROM ${usageCountersTable}
          WHERE user_id = ${userId} AND usage_date = ${date} AND kind = ${kind}
          LIMIT 1
        `;
        const used = Number(rows[0]?.used ?? 0);
        if (limit !== null && used >= limit) throw new UsageLimitError(kind, limit, used);
        await tx`
          UPSERT INTO ${usageCountersTable}
            (user_id, usage_date, kind, used)
          VALUES (${userId}, ${date}, ${kind}, ${used + 1})
        `;
        await tx`
          INSERT INTO ${usageEventsTable}
            (user_id, usage_date, event_id, kind, created_at)
          VALUES (${userId}, ${date}, ${event.id}, ${kind}, ${event.createdAt})
        `;
      });
      return getUsageSnapshot(userId, now);
    }
    const snapshot = await getUsageSnapshot(userId, now);
    const used = snapshot[kind];
    if (limit !== null && used >= limit) throw new UsageLimitError(kind, limit, used);
    const file = path.join(root, "account", "usage", date + ".json");
    const events = await readJson<UsageEvent[]>(file, []);
    events.push(event);
    await writeJsonAtomic(file, events);
    return { ...snapshot, [kind]: used + 1 };
  });
}

/** Списание по тарифу аккаунта: оплаченная подписка поднимает дневные лимиты сразу. */
export async function consumeUsageForCurrentPlan(userId: string, kind: UsageKind, now = new Date()) {
  return consumeUsage(userId, kind, await accountPlanFor(userId), now);
}

/** То же самое под прежним именем: граница зависит от подписки, а не от константы. */
export async function consumeUsageForAccountPlan(userId: string, kind: UsageKind, now = new Date()) {
  return consumeUsage(userId, kind, await accountPlanFor(userId), now);
}

/** Месяц и его прошедшие дни: по ним суммируется расход токенов. */
function monthWindow(now = new Date()) {
  const today = utcDay(now);
  const month = today.slice(0, 7);
  const days: string[] = [];
  for (let day = 1; day <= Number(today.slice(8, 10)); day++) {
    days.push(month + "-" + String(day).padStart(2, "0"));
  }
  return { month, first: month + "-01", today, days };
}

/**
 * Сколько токенов встроенной модели аккаунт потратил с начала календарного месяца (UTC).
 *
 * Считается по `model_usage`, а не по отдельному счётчику: источник правды у расхода один, и
 * ручная правка счётчика не смогла бы с ним разойтись. В журнал попадают только запуски
 * встроенной модели платформы (`agent-runtime.ts`), поэтому пул не тратится на ключ пользователя.
 * В YDB это один запрос по диапазону дат, в файловом режиме — чтение дней месяца (их не больше 31).
 */
async function monthlyTokensUsed(userId: string, now = new Date()): Promise<{ month: string; used: number }> {
  const { month, first, today, days } = monthWindow(now);
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{ prompt_tokens: number | string | bigint; completion_tokens: number | string | bigint }>>`
      SELECT prompt_tokens, completion_tokens FROM ${ydbQuery().identifier(getTable("model_usage"))}
      WHERE user_id = ${userId} AND usage_date >= ${first} AND usage_date <= ${today}
    `;
    return {
      month,
      used: rows.reduce((sum, row) => sum + Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0), 0),
    };
  }
  let used = 0;
  for (const date of days) {
    const records = await readJson<UsageCostRecord[]>(path.join(root, "account", "costs", date + ".json"), []);
    for (const record of records) {
      if (record.userId !== userId) continue;
      used += record.promptTokens + record.completionTokens;
    }
  }
  return { month, used };
}

/**
 * Пул токенов тарифа на текущий месяц. `limit: 0` — пула нет (бесплатный тариф живёт дневным
 * лимитом запусков), поэтому `remaining` тоже 0 и интерфейс шкалу не рисует.
 *
 * `bonus` — токены, начисленные администратором на этот месяц (account/token-bonus.ts). В `limit`
 * они уже входят, отдельным полем приходят только для того, чтобы шкала могла их назвать.
 */
export type TokenBudget = { month: string; used: number; limit: number; bonus: number; remaining: number };

export async function getTokenBudget(userId: string, plan: PlanId, now = new Date()): Promise<TokenBudget> {
  const { month, used } = await monthlyTokensUsed(userId, now);
  const planPool = limitsForPlan(plan).agentTokensPerMonth;
  // Надбавка имеет смысл только там, где есть пул: на бесплатном тарифе действует дневной лимит.
  const bonus = planPool > 0 ? await tokenBonusFor(userId, month) : 0;
  const limit = planPool + bonus;
  return { month, used, limit, bonus, remaining: limit > 0 ? Math.max(0, limit - used) : 0 };
}

/**
 * Сколько кредитов аккаунт потратил с начала календарного месяца (UTC).
 *
 * Источник тот же, что у токенов — `model_usage`, но суммируется уже готовое списание `credits`.
 * Старые строки без кредитов оцениваются по базовому курсу, чтобы апгрейд тарифа не обнулял
 * фактически потраченный месяц. Бесплатные запуски в кредиты не превращаются.
 */
async function monthlyCreditsUsed(userId: string, now = new Date()): Promise<{ month: string; used: number }> {
  const { month, first, today, days } = monthWindow(now);
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{
      prompt_tokens: number | string | bigint;
      completion_tokens: number | string | bigint;
      credits: number | string | bigint | null;
      model: string;
      model_id: string | null;
    }>>`
      SELECT prompt_tokens, completion_tokens, credits, model, model_id
      FROM ${ydbQuery().identifier(getTable("model_usage"))}
      WHERE user_id = ${userId} AND usage_date >= ${first} AND usage_date <= ${today}
    `;
    return {
      month,
      used: rows.reduce((sum, row) => sum + creditsForRecord({
        credits: Number(row.credits ?? 0),
        model: row.model,
        modelId: row.model_id ?? "",
        promptTokens: Number(row.prompt_tokens ?? 0),
        completionTokens: Number(row.completion_tokens ?? 0),
      }), 0),
    };
  }
  let used = 0;
  for (const date of days) {
    const records = await readJson<UsageCostRecord[]>(path.join(root, "account", "costs", date + ".json"), []);
    for (const record of records) {
      if (record.userId !== userId) continue;
      used += creditsForRecord(record);
    }
  }
  return { month, used };
}

/**
 * Месячный бюджет кредитов. `limit: 0` — кредитов у тарифа нет (бесплатный тариф живёт
 * дневным лимитом запусков). Надбавка администратора приходит в токенах; 10 000 токенов = 1
 * кредит, поэтому старые подарки продолжают работать и после перехода на кредиты.
 */
export type CreditBudget = {
  month: string;
  used: number;
  /** Месячный лимит тарифа и админской надбавки; докупленные кредиты сюда не входят. */
  planLimit: number;
  /** Общий доступный лимит: месячный пул плюс неистраченные докупленные кредиты. */
  limit: number;
  bonus: number;
  /** Остаток докупленных кредитов; он не сгорает при смене месяца. */
  purchased: number;
  remaining: number;
};

export async function getCreditBudget(userId: string, plan: PlanId, now = new Date()): Promise<CreditBudget> {
  const { month } = monthWindow(now);
  const planCredits = creditPoolFor(plan);
  if (planCredits <= 0) {
    return { month, used: 0, planLimit: 0, limit: 0, bonus: 0, purchased: 0, remaining: 0 };
  }
  const { used } = await monthlyCreditsUsed(userId, now);
  const bonusTokens = await tokenBonusFor(userId, month);
  const bonus = Math.floor(bonusTokens / 10_000);
  const planLimit = planCredits + bonus;
  const purchased = await creditBalance(userId);
  const limit = planLimit + purchased;
  return { month, used, planLimit, limit, bonus, purchased, remaining: Math.max(0, limit - used) };
}

/**
 * Списывает с докупленного баланса только ту часть запуска, которая не помещалась в месячный
 * лимит тарифа. Вызывается после записи `model_usage`, поэтому `used` уже включает этот запуск.
 * Если запуск повторно записывается с тем же run_id, разница не появляется и списания нет.
 */
async function consumePurchasedCreditsForRun(userId: string, runId: string, credits: number, now: Date) {
  if (credits <= 0) return;
  const plan = await accountPlanFor(userId);
  if (plan === "free") return;
  const { month } = monthWindow(now);
  const planLimit = creditPoolFor(plan) + Math.floor(await tokenBonusFor(userId, month) / 10_000);
  const { used } = await monthlyCreditsUsed(userId, now);
  const usedBefore = Math.max(0, used - credits);
  const overage = Math.max(0, used - planLimit) - Math.max(0, usedBefore - planLimit);
  if (overage > 0) await recordCreditConsumption(userId, runId, overage, now);
}

/** Отказ по кредитному бюджету: отдельный код, чтобы панель не путала его с дневной квотой. */
export class CreditBudgetError extends Error {
  readonly statusCode = 429;
  readonly code = "CREDIT_BUDGET_EXHAUSTED";

  constructor(readonly used: number, readonly limit: number) {
    super("Месячный лимит кредитов тарифа исчерпан");
    this.name = "CreditBudgetError";
  }
}

/** Отказ по пулу токенов: отдельный код, чтобы панель сказала «пул исчерпан», а не «дневной лимит». */
export class TokenBudgetError extends Error {
  readonly statusCode = 429;
  readonly code = "TOKEN_BUDGET_EXHAUSTED";

  constructor(readonly used: number, readonly limit: number) {
    super("Месячный пул токенов тарифа исчерпан");
    this.name = "TokenBudgetError";
  }
}

/**
 * Запуск агента. На бесплатном тарифе считаются запуски встроенной модели: она отвечает за счёт
 * платформы, а кредитов на нём нет. На платном — сначала проверяется месячный бюджет кредитов;
 * дневного лимита запусков там нет, но счётчик всё равно пишется для истории и аналитики.
 * Проект со своим AI-провайдером тратит свои токены и свой ключ, поэтому его запуски не
 * считаются и не блокируются — вместо ошибки возвращается текущий снимок использования, чтобы
 * панель показала те же цифры, что и раньше.
 */
export async function consumeAgentRun(userId: string, options: { ownProvider: boolean }, now = new Date()) {
  if (options.ownProvider) return getUsageSnapshot(userId, now);
  const plan = await accountPlanFor(userId);
  // Платный тариф ограничен кредитами, а не сырыми токенами: Max и Mini стоят по-разному.
  const planCredits = creditPoolFor(plan);
  if (planCredits > 0) {
    const budget = await getCreditBudget(userId, plan, now);
    if (budget.used >= budget.limit) throw new CreditBudgetError(budget.used, budget.limit);
  }
  return consumeUsage(userId, "agentRuns", plan, now);
}

export type RunUsageInput = {
  runId: string;
  projectId: string;
  conversationId?: string;
  model: string;
  /** id каталога (`nestdev`, `max`, `mini`), а не upstream-имя. */
  modelId?: string;
  promptTokens: number;
  completionTokens: number;
  /** Часть promptTokens, прочитанная из кэша провайдера; не вычитается из бюджета. */
  cachedPromptTokens?: number;
  /** Сколько кредитов списано за запуск; пусто — старый запуск без кредитного учёта. */
  credits?: number;
  estimated: boolean;
};

type UsageCostRecord = {
  id: string;
  userId: string;
  date: string;
  projectId: string;
  conversationId: string;
  model: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  credits: number;
  estimated: boolean;
  createdAt: string;
};

/** Публичная строка расхода: upstream-модель здесь не показывается, только имя NestDev. */
export type CostModelUsage = {
  id: string;
  name: string;
  promptTokens: number;
  completionTokens: number;
  runs: number;
};

export type CostSnapshot = {
  date: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  /** Входные токены, прочитанные из кэша провайдера; уже входят в promptTokens. */
  cachedPromptTokens: number;
  exact: boolean;
  pricesConfigured: boolean;
  costEstimate: number | null;
  currency: string;
  /** Расход за сегодня по публичным моделям NestDev, без upstream-имён. */
  models: CostModelUsage[];
  lastRun: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    exact: boolean;
    costEstimate: number | null;
    createdAt: string;
  } | null;
};

/** Один день для вкладки биллинга: что потрачено и сколько это стоит. */
export type BillingHistoryDay = {
  date: string;
  agentRuns: number;
  browserChecks: number;
  webSearches: number;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  /** Списано кредитов за день; старые строки без кредитов оцениваются по токенам. */
  credits: number;
  costEstimate: number | null;
};

export type BillingHistory = {
  currency: string;
  pricesConfigured: boolean;
  /** Дни по возрастанию даты: так их рисует график, без переворота на клиенте. */
  days: BillingHistoryDay[];
};

type PlatformPricing = { inputPerMillion: number; outputPerMillion: number; currency: string };

function utcDaysBack(days: number, now = new Date()) {
  const dates: string[] = [];
  for (let index = days - 1; index >= 0; index--) {
    dates.push(new Date(now.getTime() - index * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * История трат за последние дни — то, что человек видит на вкладке биллинга.
 *
 * Запуски, браузерные проверки и поиски живут в счётчиках, а токены и деньги — в `model_usage`,
 * поэтому оба источника сводятся в один ряд по дню. Пустые дни остаются в списке: без них график
 * врал бы о перерывах в работе, а подпись «сегодня» съезжала бы на вчера.
 */
export async function getBillingHistory(userId: string, days = 7, now = new Date()): Promise<BillingHistory> {
  const dates = utcDaysBack(days, now);
  const from = dates[0] ?? utcDay(now);
  const to = dates[dates.length - 1] ?? utcDay(now);
  const counters = new Map<string, { agentRuns: number; browserChecks: number; webSearches: number }>();
  const usageByDay = new Map<string, { runs: number; promptTokens: number; completionTokens: number; cachedPromptTokens: number; credits: number; costEstimate: number }>();
  const pricing = platformPricing();

  for (const date of dates) {
    counters.set(date, { agentRuns: 0, browserChecks: 0, webSearches: 0 });
    usageByDay.set(date, { runs: 0, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, credits: 0, costEstimate: 0 });
  }

  if (isYdbEnabled()) {
    const [counterRows] = await ydbQuery()<Array<{usage_date: string; kind: string; used: number | string | bigint}>>`
      SELECT usage_date, kind, used FROM ${ydbQuery().identifier(getTable("usage_counters"))}
      WHERE user_id = ${userId} AND usage_date >= ${from} AND usage_date <= ${to}
    `;
    for (const row of counterRows) {
      const day = counters.get(row.usage_date);
      if (!day) continue;
      const used = Number(row.used ?? 0);
      if (row.kind === "agentRuns") day.agentRuns = used;
      else if (row.kind === "browserChecks") day.browserChecks = used;
      else if (row.kind === "webSearches") day.webSearches = used;
    }

    const [costRows] = await ydbQuery()<Array<{usage_date: string; prompt_tokens: number | string | bigint; completion_tokens: number | string | bigint; cached_prompt_tokens: number | string | bigint; credits: number | string | bigint | null; model: string; model_id: string | null}>>`
      SELECT usage_date, prompt_tokens, completion_tokens, cached_prompt_tokens, credits, model, model_id
      FROM ${ydbQuery().identifier(getTable("model_usage"))}
      WHERE user_id = ${userId} AND usage_date >= ${from} AND usage_date <= ${to}
    `;
    for (const row of costRows) {
      const day = usageByDay.get(row.usage_date);
      if (!day) continue;
      const promptTokens = Number(row.prompt_tokens ?? 0);
      const completionTokens = Number(row.completion_tokens ?? 0);
      day.runs += 1;
      day.promptTokens += promptTokens;
      day.completionTokens += completionTokens;
      day.cachedPromptTokens += Number(row.cached_prompt_tokens ?? 0);
      day.credits += creditsForRecord({
        credits: Number(row.credits ?? 0),
        model: row.model,
        modelId: row.model_id ?? "",
        promptTokens,
        completionTokens,
      });
      day.costEstimate += costFor({ promptTokens, completionTokens }, pricing) ?? 0;
    }
  } else {
    for (const date of dates) {
      const events = await readJson<UsageEvent[]>(path.join(root, "account", "usage", date + ".json"), []);
      const own = events.filter(event => event.userId === userId && event.date === date);
      const day = counters.get(date)!;
      day.agentRuns = own.filter(event => event.kind === "agentRuns").length;
      day.browserChecks = own.filter(event => event.kind === "browserChecks").length;
      day.webSearches = own.filter(event => event.kind === "webSearches").length;

      const records = (await readJson<UsageCostRecord[]>(path.join(root, "account", "costs", date + ".json"), []))
        .filter(record => record.userId === userId && record.date === date);
      const spend = usageByDay.get(date)!;
      for (const record of records) {
        spend.runs += 1;
        spend.promptTokens += record.promptTokens;
        spend.completionTokens += record.completionTokens;
        spend.cachedPromptTokens += record.cachedPromptTokens ?? 0;
        spend.credits += creditsForRecord(record);
        spend.costEstimate += costFor(record, pricing) ?? 0;
      }
    }
  }

  return {
    currency: pricing?.currency ?? "USD",
    pricesConfigured: Boolean(pricing),
    days: dates.map(date => ({
      date,
      ...counters.get(date)!,
      ...usageByDay.get(date)!,
      costEstimate: pricing ? usageByDay.get(date)!.costEstimate : null,
    })),
  };
}

/** Optional pricing of the platform model, per 1M tokens. Returns null until configured. */
export function platformPricing(): PlatformPricing | null {
  const input = Number(process.env.PLATFORM_AI_PRICE_INPUT_PER_MILLION ?? "");
  const output = Number(process.env.PLATFORM_AI_PRICE_OUTPUT_PER_MILLION ?? "");
  const hasInput = Number.isFinite(input) && input > 0;
  const hasOutput = Number.isFinite(output) && output > 0;
  if (!hasInput && !hasOutput) return null;
  return {
    inputPerMillion: hasInput ? input : 0,
    outputPerMillion: hasOutput ? output : 0,
    currency: (process.env.PLATFORM_AI_PRICE_CURRENCY ?? "USD").trim() || "USD",
  };
}

function costFor(record: { promptTokens: number; completionTokens: number }, pricing: PlatformPricing | null) {
  if (!pricing) return null;
  return (record.promptTokens / 1_000_000) * pricing.inputPerMillion + (record.completionTokens / 1_000_000) * pricing.outputPerMillion;
}

/**
 * Кредиты старой строки `model_usage`: новые запуски пишут точное число, а записи до кредитного
 * учёта оцениваются по базовому курсу 10 000 токенов = 1 кредит. Бесплатная модель не должна
 * превращаться в кредиты при апгрейде тарифа посередине месяца.
 */
function creditsForRecord(record: {
  credits: number;
  model: string;
  modelId?: string;
  promptTokens: number;
  completionTokens: number;
}) {
  if (record.credits > 0) return record.credits;
  if (record.model === "free-model" || record.modelId === "nestdev-air" || record.modelId === "air") return 0;
  // Новая строка с явным нулём не должна превращаться в кредиты: model_id появился вместе
  // с кредитным учётом. Если id пуст — это старый запуск, его оцениваем по токенам.
  if (record.modelId) return 0;
  return Math.ceil((record.promptTokens + record.completionTokens) / 10_000);
}

const PUBLIC_MODEL_LABELS: Record<string, { id: string; name: string }> = {
  "": { id: "nestdev", name: "NestDev" },
  "nestdev": { id: "nestdev", name: "NestDev" },
  "nestdev-air": { id: "nestdev-air", name: "NestDev Air" },
  "air": { id: "nestdev-air", name: "NestDev Air" },
  "mini": { id: "mini", name: "NestDev Mini" },
  "max": { id: "max", name: "NestDev Max" },
};
const PUBLIC_MODEL_ORDER = ["nestdev", "mini", "max", "nestdev-air", "other"];

/**
 * id запуска — публичный идентификатор каталога, а не upstream-имя. Неизвестные id не раскрываем:
 * они попадают в одну строку «Дополнительная модель». Так пользователь видит расход своих моделей,
 * но не может узнать, какой внешний провайдер стоит за Mini или Max.
 */
function publicModelOf(modelId: string) {
  return PUBLIC_MODEL_LABELS[modelId] ?? { id: "other", name: "Дополнительная модель" };
}

function modelUsageOf(records: UsageCostRecord[]): CostModelUsage[] {
  const rows = new Map<string, CostModelUsage>();
  for (const record of records) {
    const meta = publicModelOf(record.modelId ?? "");
    const row = rows.get(meta.id) ?? { ...meta, promptTokens: 0, completionTokens: 0, runs: 0 };
    row.promptTokens += record.promptTokens;
    row.completionTokens += record.completionTokens;
    row.runs += 1;
    rows.set(meta.id, row);
  }
  return [...rows.values()].sort((a, b) => PUBLIC_MODEL_ORDER.indexOf(a.id) - PUBLIC_MODEL_ORDER.indexOf(b.id));
}

/** Records model spend of one agent run so the owner can measure real cost per generated site. */
export async function recordRunUsage(userId: string, input: RunUsageInput, now = new Date()) {
  const date = utcDay(now);
  const record: UsageCostRecord = {
    id: input.runId,
    userId,
    date,
    projectId: input.projectId,
    conversationId: input.conversationId ?? "",
    model: input.model,
    modelId: input.modelId?.trim() ?? "",
    promptTokens: Math.max(0, Math.round(input.promptTokens)),
    completionTokens: Math.max(0, Math.round(input.completionTokens)),
    cachedPromptTokens: Math.max(0, Math.min(
      Math.round(input.cachedPromptTokens ?? 0),
      Math.round(input.promptTokens),
    )),
    credits: Math.max(0, Math.round(input.credits ?? 0)),
    estimated: input.estimated,
    createdAt: now.toISOString(),
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      UPSERT INTO ${ydbQuery().identifier(getTable("model_usage"))}
        (user_id, usage_date, run_id, project_id, conversation_id, model, model_id, prompt_tokens, completion_tokens, cached_prompt_tokens, credits, estimated, created_at)
      VALUES (${userId}, ${date}, ${record.id}, ${record.projectId}, ${record.conversationId}, ${record.model}, ${record.modelId}, ${record.promptTokens}, ${record.completionTokens}, ${record.cachedPromptTokens}, ${record.credits}, ${record.estimated}, ${record.createdAt})
    `;
    await consumePurchasedCreditsForRun(userId, record.id, record.credits, now);
    return record;
  }
  let duplicate = false;
  await withLock("json-cost:" + date, async () => {
    const file = path.join(root, "account", "costs", date + ".json");
    const records = await readJson<UsageCostRecord[]>(file, []);
    if (records.some(item => item.userId === userId && item.id === record.id)) { duplicate = true; return; }
    records.push(record);
    await writeJsonAtomic(file, records);
  });
  // Повторная запись того же запуска не должна ни удваивать расход, ни списывать кредиты ещё раз.
  if (!duplicate) await consumePurchasedCreditsForRun(userId, record.id, record.credits, now);
  return record;
}

export async function getCostSnapshot(userId: string, now = new Date()): Promise<CostSnapshot> {
  const date = utcDay(now);
  let records: UsageCostRecord[];
  if (isYdbEnabled()) {
    const [rows] = await ydbQuery()<Array<{run_id:string;project_id:string;conversation_id:string;model:string;model_id:string|null;prompt_tokens:number|string|bigint;completion_tokens:number|string|bigint;cached_prompt_tokens:number|string|bigint;credits:number|string|bigint|null;estimated:boolean;created_at:string}>>`
      SELECT run_id, project_id, conversation_id, model, model_id, prompt_tokens, completion_tokens, cached_prompt_tokens, credits, estimated, created_at
      FROM ${ydbQuery().identifier(getTable("model_usage"))}
      WHERE user_id = ${userId} AND usage_date = ${date}
      ORDER BY created_at DESC
    `;
    records = rows.map(row => ({
      id: row.run_id,
      userId,
      date,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      model: row.model,
      modelId: row.model_id ?? "",
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      cachedPromptTokens: Number(row.cached_prompt_tokens ?? 0),
      credits: Number(row.credits ?? 0),
      estimated: Boolean(row.estimated),
      createdAt: row.created_at,
    }));
  } else {
    const file = path.join(root, "account", "costs", date + ".json");
    records = (await readJson<UsageCostRecord[]>(file, [])).filter(record => record.userId === userId && record.date === date);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const pricing = platformPricing();
  const promptTokens = records.reduce((sum, record) => sum + record.promptTokens, 0);
  const completionTokens = records.reduce((sum, record) => sum + record.completionTokens, 0);
  const cachedPromptTokens = records.reduce((sum, record) => sum + (record.cachedPromptTokens ?? 0), 0);
  const last = records[0];
  return {
    date,
    runs: records.length,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    exact: records.length > 0 && records.every(record => !record.estimated),
    pricesConfigured: Boolean(pricing),
    costEstimate: pricing ? records.reduce((sum, record) => sum + (costFor(record, pricing) ?? 0), 0) : null,
    currency: pricing?.currency ?? "USD",
    models: modelUsageOf(records),
    lastRun: last
      ? {
          promptTokens: last.promptTokens,
          completionTokens: last.completionTokens,
          cachedPromptTokens: last.cachedPromptTokens ?? 0,
          exact: !last.estimated,
          costEstimate: costFor(last, pricing),
          createdAt: last.createdAt,
        }
      : null,
  };
}
