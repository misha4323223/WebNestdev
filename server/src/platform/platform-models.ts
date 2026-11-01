import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../storage/secret-crypto.js";
import type { PlatformProviderConfig } from "../provider/platform-provider.js";
import {
  BASE_CREDIT_RATES,
  creditRatesProblem,
  defaultCreditRatesFor,
  normalizeCreditRates,
  type CreditRates,
} from "../account/credits.js";

/**
 * Каталог моделей платформы, которые администратор добавляет из внешней админки.
 *
 * Главная модель (`PLATFORM_AI_*`) живёт отдельно и остаётся моделью по умолчанию. Здесь лежат
 * дополнительные модели — Max и Mini, — и любая другая OpenAI-совместимая модель, которую
 * администратор решит подключить. У каждой свой адрес, ключ, контекст и набор тарифов.
 *
 * Ключи не хранятся открытым текстом: файл лежит рядом с остальными секретами платформы и
 * шифруется тем же AES-GCM-хранилищем, что и ключи проектов. Наружу API отдаёт только
 * `hasKey`, а не сам ключ. Один файл на процесс/том — как и `platform/env.json`; для текущей
 * однохостовой установки этого достаточно, а модель читается на каждый запуск, поэтому
 * добавление из админки действует без перезапуска.
 */
export type PlatformModelPlan = "pro" | "team";

export type PlatformModelRecord = {
  id: string;
  name: string;
  description: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  plans: PlatformModelPlan[];
  enabled: boolean;
  /** Бюджет промпта в токенах; пусто — общий бюджет платного тарифа. */
  contextTokens?: number;
  /** Сколько кредитов стоит миллион входных и выходных токенов этой модели. */
  creditRates: CreditRates;
  createdAt: string;
  updatedAt: string;
};

export type PlatformModelInput = {
  name?: string;
  description?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearKey?: boolean;
  plans?: PlatformModelPlan[];
  enabled?: boolean;
  contextTokens?: number | null;
  /** Частичное обновление ставок; `null` возвращает стартовые ставки модели. */
  creditRates?: Partial<CreditRates> | null;
};

export type PlatformModelAdminView = Omit<PlatformModelRecord, "apiKey"> & { hasKey: boolean };

type StoredPlatformModel = Omit<PlatformModelRecord, "apiKey"> & { apiKey?: string };
type StoreFile = { version: 1; models: StoredPlatformModel[] };

const RESERVED_IDS = new Set(["nestdev", "nestdev-air", "air", "free"]);

function root() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

function storeFile() {
  return path.join(root(), "platform", "models.json");
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function uniquePlans(plans: PlatformModelPlan[] | undefined): PlatformModelPlan[] {
  const result: PlatformModelPlan[] = [];
  for (const plan of plans ?? ["pro", "team"]) {
    if ((plan === "pro" || plan === "team") && !result.includes(plan)) result.push(plan);
  }
  return result.length ? result : ["pro", "team"];
}

/** Идентификатор приходит из админки, поэтому его форма проверяется и здесь, а не только в route. */
export function platformModelIdProblem(id: string): string | null {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
    return "id: 2–32 символа, латиница в нижнем регистре, цифры и дефис; начинается с буквы";
  }
  if (RESERVED_IDS.has(id)) return "id «" + id + "» занят основной или бесплатной моделью";
  return null;
}

async function readStore(): Promise<PlatformModelRecord[]> {
  let raw: string;
  try {
    raw = await readFile(storeFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Хранилище моделей платформы повреждено: platform/models.json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Хранилище моделей платформы повреждено: platform/models.json");
  }
  const models = Array.isArray((parsed as { models?: unknown }).models)
    ? (parsed as { models: unknown[] }).models
    : [];
  const result: PlatformModelRecord[] = [];
  for (const value of models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as StoredPlatformModel;
    if (!record.id || !record.name || !record.baseUrl || !record.model) continue;
    let apiKey = record.apiKey;
    if (apiKey && isEncryptedSecret(apiKey)) {
      try {
        apiKey = decryptSecret(apiKey);
      } catch (error) {
        // Не подменяем модель молча: без ключа она не работает, и админка должна это видеть.
        console.error("[models] ключ модели " + record.id + " не расшифрован (изменился WEBNESTDEV_ENCRYPTION_KEY?): " + (error instanceof Error ? error.message : String(error)));
        apiKey = undefined;
      }
    }
    result.push({
      ...record,
      ...(apiKey ? { apiKey } : { apiKey: undefined }),
      description: record.description ?? "",
      provider: record.provider ?? "OpenAI-compatible",
      plans: uniquePlans(record.plans),
      enabled: record.enabled !== false,
      // Старые записи каталога появились до кредитов: им нужен понятный старт, а не ноль.
      creditRates: normalizeCreditRates(record.creditRates, defaultCreditRatesFor(record.id)),
    });
  }
  return result;
}

async function writeStore(models: PlatformModelRecord[]) {
  const file = storeFile();
  await mkdir(path.dirname(file), { recursive: true });
  const payload: StoreFile = {
    version: 1,
    models: models.map(model => ({
      ...model,
      ...(model.apiKey ? { apiKey: encryptSecret(model.apiKey) } : {}),
    })),
  };
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

/** Все сохранённые модели, включая выключенные: это нужно админке. */
export async function listPlatformModels(): Promise<PlatformModelRecord[]> {
  return (await readStore()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getPlatformModel(id: string): Promise<PlatformModelRecord | null> {
  return (await listPlatformModels()).find(model => model.id === id) ?? null;
}

/** Только модели, разрешённые тарифу и включённые администратором. */
export async function getPlatformModelForPlan(id: string, plan: PlatformModelPlan | "free"): Promise<PlatformModelRecord | null> {
  if (plan === "free") return null;
  const model = await getPlatformModel(id);
  return model?.enabled && model.plans.includes(plan) ? model : null;
}

/**
 * Создание и обновление одной записи. Пустой `apiKey` сохраняет уже записанный ключ: так смена
 * адреса или названия не требует повторной вставки секрета. `clearKey` удаляет его явно.
 */
export async function savePlatformModel(id: string, input: PlatformModelInput): Promise<PlatformModelRecord> {
  const problem = platformModelIdProblem(id);
  if (problem) throw new Error(problem);
  const models = await readStore();
  const existing = models.find(model => model.id === id);
  const now = new Date().toISOString();
  const defaultName = id === "max" ? "NestDev Max" : id === "mini" ? "NestDev Mini" : id;
  const defaultDescription = id === "max" ? "Для сложных задач" : id === "mini" ? "Экономичные итерации" : "Дополнительная модель платформы";
  const name = input.name?.trim() || existing?.name || defaultName;
  const provider = input.provider?.trim() || existing?.provider || "OpenAI-compatible";
  const baseUrl = input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : existing?.baseUrl;
  const upstream = input.model?.trim() || existing?.model;
  if (!baseUrl) throw new Error("Укажите Base URL");
  if (!upstream) throw new Error("Укажите модель");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL должен начинаться с http:// или https://");
  const apiKey = input.clearKey ? undefined : input.apiKey?.trim() || existing?.apiKey;
  const contextTokens = input.contextTokens === null
    ? undefined
    : input.contextTokens !== undefined
      ? Math.round(input.contextTokens)
      : existing?.contextTokens;
  if (contextTokens !== undefined && (!Number.isFinite(contextTokens) || contextTokens < 4_000 || contextTokens > 2_000_000)) {
    throw new Error("contextTokens: от 4000 до 2 000 000");
  }
  const creditRates = input.creditRates === null
    ? defaultCreditRatesFor(id)
    : normalizeCreditRates(input.creditRates, existing?.creditRates ?? defaultCreditRatesFor(id));
  const creditProblem = creditRatesProblem(creditRates);
  if (creditProblem) throw new Error(creditProblem);
  const next: PlatformModelRecord = {
    id,
    name,
    description: input.description?.trim() ?? existing?.description ?? defaultDescription,
    provider,
    baseUrl,
    model: upstream,
    ...(apiKey ? { apiKey } : {}),
    plans: uniquePlans(input.plans ?? existing?.plans),
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(contextTokens ? { contextTokens } : {}),
    creditRates,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const nextModels = existing
    ? models.map(model => model.id === id ? next : model)
    : [...models, next];
  await writeStore(nextModels);
  return next;
}

export async function deletePlatformModel(id: string): Promise<boolean> {
  const models = await readStore();
  const next = models.filter(model => model.id !== id);
  if (next.length === models.length) return false;
  await writeStore(next);
  return true;
}

export function platformModelAdminView(model: PlatformModelRecord): PlatformModelAdminView {
  const { apiKey, ...rest } = model;
  return { ...rest, hasKey: Boolean(apiKey) };
}

/** Конфигурация для OpenAI-совместимого провайдера: ключ не покидает сервер. */
export function platformModelProviderConfig(model: PlatformModelRecord): PlatformProviderConfig {
  return {
    provider: model.provider,
    baseUrl: model.baseUrl,
    model: model.model,
    ...(model.apiKey ? { token: model.apiKey } : {}),
  };
}

export type PaidPlatformModelChoice = {
  id: string;
  name: string;
  description: string;
  config: PlatformProviderConfig;
  contextTokens?: number;
  creditRates: CreditRates;
  catalog: boolean;
};

/**
 * Что запускать на платном тарифе: основную модель платформы или выбранную из каталога.
 * `null` означает «выбора нет или модель недоступна»; route/runtime сами решают, как объяснить
 * это человеку. Бесплатная цепочка сюда не входит — у неё отдельный FailoverProvider.
 */
export async function resolvePaidPlatformModel(
  requestedId: string | undefined,
  plan: PlatformModelPlan,
  main: PlatformProviderConfig | null,
  mainRates: CreditRates = BASE_CREDIT_RATES,
): Promise<PaidPlatformModelChoice | null> {
  const id = requestedId?.trim();
  if (!id || id === "nestdev") {
    return main ? {
      id: "nestdev",
      name: "NestDev",
      description: "Основная модель · баланс скорости и качества",
      config: main,
      creditRates: mainRates,
      catalog: false,
    } : null;
  }
  const model = await getPlatformModelForPlan(id, plan);
  return model ? {
    id: model.id,
    name: model.name,
    description: model.description,
    config: platformModelProviderConfig(model),
    ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
    creditRates: model.creditRates,
    catalog: true,
  } : null;
}
