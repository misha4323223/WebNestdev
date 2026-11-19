/**
 * Единая точка сборки цен для админской экономики: ручная таблица, автоцены Polza и
 * инфраструктура МВС. Маршруты не должны знать, откуда пришла цена, — им нужна одна таблица
 * и один месячный расход, иначе каждый новый источник пришлось бы встраивать в каждый отчёт.
 */
import {
  readModelPriceTable,
  withCatalogPrices,
  type ModelPriceTable,
} from "./model-pricing.js";
import {
  polzaPriceRules,
  readPolzaPricing,
  type PolzaPricingOptions,
  type PolzaPricingSnapshot,
} from "./polza-pricing.js";
import {
  readMtsPricing,
  type MtsPricingOptions,
  type MtsPricingSnapshot,
} from "./mts-pricing.js";

export type AdminPricing = {
  table: ModelPriceTable;
  ai: PolzaPricingSnapshot;
  infra: MtsPricingSnapshot;
  warnings: string[];
};

export type AdminPricingOptions = {
  env?: NodeJS.ProcessEnv;
  polza?: PolzaPricingOptions;
  mts?: MtsPricingOptions;
};

export async function resolveAdminPricing(
  options: AdminPricingOptions = {},
): Promise<AdminPricing> {
  const env = options.env ?? process.env;
  const [ai, infra] = await Promise.all([
    readPolzaPricing(options.polza),
    readMtsPricing({ ...options.mts, env }),
  ]);
  const manual = readModelPriceTable(env);
  const table = withCatalogPrices(manual, polzaPriceRules(ai), {
    ...(ai.currency ? { currency: ai.currency } : {}),
  });
  return {
    table,
    ai,
    infra,
    warnings: [...ai.warnings, ...infra.warnings],
  };
}

/**
 * Компактное описание источников для ответа админки. Цены моделей перечислены явно: по ним
 * видно, какую цену и какого провайдера взял расчёт, и расхождение со счётом не приходится
 * искать в логах.
 */
function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function pricingSourcesView(pricing: AdminPricing) {
  return {
    ai: {
      configured: pricing.ai.configured,
      source: pricing.ai.source,
      fetchedAt: pricing.ai.fetchedAt,
      stale: pricing.ai.stale,
      currency: pricing.ai.currency,
      modelCount: pricing.ai.quotes.length,
      models: pricing.ai.quotes,
      warnings: pricing.ai.warnings,
    },
    infra: {
      configured: pricing.infra.configured,
      source: pricing.infra.source,
      fetchedAt: pricing.infra.fetchedAt,
      stale: pricing.infra.stale,
      currency: pricing.infra.currency,
      monthly: money(pricing.infra.monthly),
      compute: money(pricing.infra.compute),
      disks: money(pricing.infra.disks),
      network: money(pricing.infra.network),
      extra: money(pricing.infra.extra),
      resources: pricing.infra.resources.map(resource => ({
        name: resource.name,
        zone: resource.zone,
        power: resource.power,
        category: resource.category,
        vcpu: resource.vcpu,
        ramGb: resource.ramGb,
        disks: resource.disks,
        externalIps: resource.externalIps,
      })),
      rates: pricing.infra.rates,
      warnings: pricing.infra.warnings,
    },
  };
}
