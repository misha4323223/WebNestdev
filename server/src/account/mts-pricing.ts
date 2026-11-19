/**
 * Инфраструктурная себестоимость МТС Web Services для админской экономики.
 *
 * У МВС нет документированного Billing API, поэтому счёт нельзя прочитать запросом. Зато есть
 * два официальных источника, которых достаточно для оценки:
 *
 * - публичный прайс-лист `mws.ru` — ставки за vCPU, RAM, сетевой диск и активный внешний IP;
 * - Compute API — фактические ВМ проекта: тип, зона, диски и внешние адреса.
 *
 * Стоимость считается как «прайс-лист × ресурсы», а не как остаток по счёту. Это осознанно
 * консервативная оценка: она не зависит от того, выключена ли вторая нода сегодня, потому что
 * целевой production — две включённые ноды. Выключенные ВМ попадают в сумму и отмечаются в
 * предупреждении, иначе цена подписки занижалась бы в дни простоя второй машины.
 *
 * Если МВС или прайс-лист недоступны, работает прежняя ручная переменная
 * `PLATFORM_INFRA_COST_PER_MONTH`. Дополнительные статьи, которых нет в Compute (S3, SMS,
 * домены), задаются отдельно в `PLATFORM_INFRA_EXTRA_PER_MONTH` и прибавляются к расчёту.
 */
import { readInfraCostMonthly } from "./model-pricing.js";
import { mwsConfigured, mwsProject, mwsRequest } from "../mws/mws-auth.js";

export type MtsPriceRate = {
  label: string;
  unit: string;
  hourly: number | null;
  monthly: number | null;
};

export type MtsVmResource = {
  id: string;
  name: string;
  zone: string;
  region: string;
  power: "ON" | "OFF" | "UNKNOWN";
  category: string;
  vcpu: number;
  ramGb: number;
  disks: Array<{ gb: number; type: string; iops: number }>;
  externalIps: number;
};

export type MtsPricingSnapshot = {
  configured: boolean;
  source: "mts-price-list" | "manual" | "none";
  fetchedAt: string | null;
  stale: boolean;
  currency: "RUB";
  monthly: number;
  compute: number;
  disks: number;
  network: number;
  extra: number;
  resources: MtsVmResource[];
  rates: MtsPriceRate[];
  warnings: string[];
};

export type MtsPricingOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  refresh?: boolean;
  project?: string | null;
  request?: typeof mwsRequest;
};

export const MTS_PRICING_URL_ENV = "MTS_PRICING_URL";
export const INFRA_EXTRA_ENV = "PLATFORM_INFRA_EXTRA_PER_MONTH";
const DEFAULT_PRICING_URL =
  "https://mws.ru/docs/cloud-platform/about/general/mws-cloud-platform-pricing.html";
const CACHE_TTL_MS = 6 * 60 * 60_000;
const STALE_TTL_MS = 7 * 24 * 60 * 60_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

type PriceCache = { rates: MtsPriceRate[]; fetchedAt: number };
const cache = new Map<string, PriceCache>();
const failureUntil = new Map<string, number>();

/** Тестам нужна чистая память между прогонами. */
export function resetMtsPricingCache() {
  cache.clear();
  failureUntil.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rub(value: string): number | null {
  const text = value.replace(/\s/g, "").replace(/\u00a0/g, "").replace(",", ".");
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOfCell(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Разбор таблиц прайс-листа. Нужны только строки с четырьмя колонками и числом в последней:
 * параметр, единица, ₽/час, ₽/мес. Строки трафика с одной ценой пропускаются — они не
 * помесячные и в постоянные расходы не входят.
 */
export function parseMtsPriceList(html: string): MtsPriceRate[] {
  const rates: MtsPriceRate[] = [];
  const seen = new Set<string>();
  const rows = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => textOfCell(match[1] ?? ""));
    if (cells.length < 4) continue;
    const label = cells[0] ?? "";
    const monthly = rub(cells[cells.length - 1] ?? "");
    if (!label || monthly === null || seen.has(label)) continue;
    seen.add(label);
    rates.push({
      label,
      unit: cells[1] ?? "",
      hourly: rub(cells[cells.length - 2] ?? ""),
      monthly,
    });
  }
  return rates;
}

function parseVmType(value: string): { category: string; vcpu: number; ramGb: number } | null {
  const tail = value.trim().split("/").at(-1) ?? "";
  const match = /^([a-z][a-z0-9]*)-(\d+)-(\d+)$/i.exec(tail);
  if (!match) return null;
  const vcpu = Number(match[2]);
  const ramGb = Number(match[3]);
  if (!Number.isFinite(vcpu) || !Number.isFinite(ramGb) || vcpu <= 0 || ramGb <= 0) return null;
  return { category: match[1].toLowerCase(), vcpu, ramGb };
}

function regionOf(zone: string): string {
  return zone.replace(/-[a-z]$/i, "");
}

function sizeGb(value: unknown): number {
  const match = String(value ?? "").match(/([\d.]+)\s*GB/i);
  return match ? Number(match[1]) : 0;
}

/** Ресурсы ВМ из ответа Compute API; экспортируется для тестов без сети. */
export function parseMtsVmResources(body: unknown): MtsVmResource[] {
  const record = asRecord(body);
  const items = record && Array.isArray(record.items) ? record.items : [];
  const resources: MtsVmResource[] = [];
  for (const item of items) {
    const vm = asRecord(item);
    if (!vm) continue;
    const metadata = asRecord(vm.metadata);
    const spec = asRecord(vm.spec);
    const status = asRecord(vm.status);
    if (!spec) continue;
    const type = parseVmType(String(spec.vmType ?? ""));
    if (!type) continue;
    const zone = String(spec.zone ?? "");
    const disks: Array<{ gb: number; type: string; iops: number }> = [];
    const storage = asRecord(spec.storage);
    const statusStorage = asRecord(status?.storage);
    const statusDisks = Array.isArray(statusStorage?.disks) ? statusStorage.disks : [];
    let diskIndex = 0;
    for (const raw of Array.isArray(storage?.disks) ? storage.disks : []) {
      const disk = asRecord(asRecord(raw)?.disk);
      const diskSpec = asRecord(disk?.spec);
      if (!diskSpec) continue;
      const gb = sizeGb(diskSpec.size);
      const diskType = String(diskSpec.diskType ?? "").trim().toUpperCase();
      const statusDisk = asRecord(statusDisks[diskIndex]);
      const iops = Number(diskSpec.iops ?? statusDisk?.iops ?? 0);
      diskIndex += 1;
      if (gb > 0 && diskType) {
        disks.push({ gb, type: diskType, iops: Number.isFinite(iops) && iops > 0 ? iops : 0 });
      }
    }

    // Активный внешний IP — тот, который реально выдан ВМ. У выключенной node-2 в status
    // нет oneToOneNat, хотя в spec остался пустой шаблон NAT: считать его оплаченным нельзя.
    let externalIps = 0;
    const network = asRecord(status?.network);
    for (const raw of Array.isArray(network?.networkInterfaces) ? network.networkInterfaces : []) {
      const iface = asRecord(raw);
      for (const addressRaw of Array.isArray(iface?.addresses) ? iface.addresses : []) {
        const address = asRecord(addressRaw);
        if (asRecord(address?.oneToOneNat)) externalIps += 1;
      }
    }

    const specHardware = asRecord(spec.hardware);
    const statusHardware = asRecord(status?.hardware);
    const powerRaw = String(specHardware?.power ?? statusHardware?.power ?? "").toUpperCase();
    resources.push({
      id: String(metadata?.id ?? ""),
      name: String(metadata?.displayName ?? metadata?.id ?? "VM"),
      zone,
      region: regionOf(zone),
      power: powerRaw === "ON" || powerRaw === "OFF" ? powerRaw : "UNKNOWN",
      category: type.category,
      vcpu: type.vcpu,
      ramGb: type.ramGb,
      disks,
      externalIps,
    });
  }
  return resources;
}

function rate(rates: Map<string, number>, label: string): number | null {
  const value = rates.get(label);
  return value === undefined ? null : value;
}

export type MtsMonthlyCalculation = {
  monthly: number;
  compute: number;
  disks: number;
  network: number;
  warnings: string[];
};

/** Стоимость ресурсов по ставкам прайс-листа; экспортируется для тестов. */
export function calculateMtsMonthly(
  resources: MtsVmResource[],
  rates: MtsPriceRate[],
): MtsMonthlyCalculation {
  const byLabel = new Map<string, number>();
  for (const item of rates) {
    if (item.monthly !== null) byLabel.set(item.label, item.monthly);
  }
  const warnings: string[] = [];
  let compute = 0;
  let disks = 0;
  let network = 0;
  let poweredOff = 0;

  if (resources.length === 0) warnings.push("В проекте МВС не найдено виртуальных машин.");
  for (const vm of resources) {
    if (vm.power !== "ON") poweredOff += 1;
    const vcpuRate = rate(byLabel, "Виртуальный процессор (vCPU) категории " + vm.category + " в регионе " + vm.region);
    const ramRate = rate(byLabel, "Оперативная память (RAM) категории " + vm.category + " в регионе " + vm.region);
    if (vcpuRate === null || ramRate === null) {
      warnings.push(
        "Для " + vm.name + " нет тарифа vCPU/RAM категории " + vm.category +
        " в регионе " + vm.region + ".",
      );
    } else {
      compute += vm.vcpu * vcpuRate + vm.ramGb * ramRate;
    }

    for (const disk of vm.disks) {
      const diskRate = rate(byLabel, "Объем сетевого диска (" + disk.type + ") в регионе " + vm.region);
      if (diskRate === null) {
        warnings.push("Для " + vm.name + " нет тарифа диска " + disk.type + " в регионе " + vm.region + ".");
      } else {
        disks += disk.gb * diskRate;
      }
      // В NBS-PL2 первые 1000 IOPS уже входят в объём диска; сверху оплачиваются только
      // дополнительные IOPS. Без этой строки переоценка цены подписки была бы заниженной.
      if (disk.type === "NBS-PL2" && disk.iops > 1_000) {
        const iopsRate = rate(byLabel, "Производительность сетевого диска (100 IOPS, NBS-PL2) в регионе " + vm.region);
        if (iopsRate === null) {
          warnings.push("Для " + vm.name + " нет тарифа дополнительных IOPS в регионе " + vm.region + ".");
        } else {
          disks += ((disk.iops - 1_000) / 100) * iopsRate;
        }
      }
    }

    const ipRate = rate(byLabel, "Активный внешний IP-адрес в регионе " + vm.region);
    if (vm.externalIps > 0 && ipRate === null) {
      warnings.push("Для " + vm.name + " нет тарифа активного внешнего IP в регионе " + vm.region + ".");
    } else {
      network += vm.externalIps * (ipRate ?? 0);
    }
  }
  if (poweredOff > 0) {
    warnings.push(
      "Выключенных ВМ: " + poweredOff + ". Они включены в расчёт как целевые production-ноды, " +
      "поэтому минимальная цена подписки не занижается.",
    );
  }
  return {
    monthly: compute + disks + network,
    compute,
    disks,
    network,
    warnings,
  };
}

async function loadPriceList(
  url: string,
  options: MtsPricingOptions,
): Promise<{ rates: MtsPriceRate[]; fetchedAt: string | null; stale: boolean } | null> {
  const now = options.now ?? Date.now;
  const current = cache.get(url);
  const age = current ? now() - current.fetchedAt : Infinity;
  if (!options.refresh && current && age < CACHE_TTL_MS) {
    return {
      rates: current.rates,
      fetchedAt: new Date(current.fetchedAt).toISOString(),
      stale: false,
    };
  }
  const backoff = failureUntil.get(url) ?? 0;
  if (!options.refresh && backoff > now()) {
    return current && age < STALE_TTL_MS
      ? { rates: current.rates, fetchedAt: new Date(current.fetchedAt).toISOString(), stale: true }
      : null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      headers: { accept: "text/html", "user-agent": "webnestdev-admin-economics" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("прайс-лист ответил HTTP " + response.status);
    const rates = parseMtsPriceList(await response.text());
    if (rates.length === 0) throw new Error("в прайс-листе не найдено ни одной ставки");
    cache.set(url, { rates, fetchedAt: now() });
    failureUntil.delete(url);
    return {
      rates,
      fetchedAt: new Date(now()).toISOString(),
      stale: false,
    };
  } catch (error) {
    failureUntil.set(url, now() + FAILURE_BACKOFF_MS);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("[mts] прайс-лист недоступен: " + reason);
    return current && age < STALE_TTL_MS
      ? { rates: current.rates, fetchedAt: new Date(current.fetchedAt).toISOString(), stale: true }
      : null;
  } finally {
    clearTimeout(timer);
  }
}

function manualFallback(env: NodeJS.ProcessEnv, warning: string): MtsPricingSnapshot {
  const manual = readInfraCostMonthly(env);
  return {
    configured: manual.configured,
    source: manual.configured ? "manual" : "none",
    fetchedAt: null,
    stale: false,
    currency: "RUB",
    monthly: manual.monthly,
    compute: 0,
    disks: 0,
    network: 0,
    extra: 0,
    resources: [],
    rates: [],
    warnings: [
      warning,
      manual.configured
        ? "В расчёте инфраструктуры остаётся ручная PLATFORM_INFRA_COST_PER_MONTH."
        : "Infra-стоимость не рассчитана: задайте PLATFORM_INFRA_COST_PER_MONTH.",
    ],
  };
}

export async function readMtsPricing(
  options: MtsPricingOptions = {},
): Promise<MtsPricingSnapshot> {
  const env = options.env ?? process.env;
  const url = (env[MTS_PRICING_URL_ENV] ?? "").trim() || DEFAULT_PRICING_URL;
  const priceList = await loadPriceList(url, options);
  if (!priceList) {
    return manualFallback(env, "Прайс-лист МВС недоступен: инфраструктура посчитана вручную.");
  }
  if (options.project === undefined && !mwsConfigured()) {
    return manualFallback(env, "МВС не настроен: состав ВМ неизвестен, инфраструктура посчитана вручную.");
  }

  const project = options.project === undefined ? await mwsProject() : options.project;
  if (!project) {
    return manualFallback(env, "Проект МВС не определён: состав ВМ неизвестен, инфраструктура посчитана вручную.");
  }

  const request = options.request ?? mwsRequest;
  const response = await request({
    path: "/compute/v1/projects/" + encodeURIComponent(project) + "/virtualMachines",
  });
  if (!response.ok) {
    return manualFallback(
      env,
      "Compute API МВС не отдал список ВМ (HTTP " + response.status +
      "): инфраструктура посчитана вручную.",
    );
  }

  const resources = parseMtsVmResources(response.body);
  if (resources.length === 0) {
    return manualFallback(env, "Compute API МВС не вернул ни одной ВМ: инфраструктура посчитана вручную.");
  }
  const calculated = calculateMtsMonthly(resources, priceList.rates);
  const extraRaw = Number(String(env[INFRA_EXTRA_ENV] ?? "").replace(",", "."));
  const extra = Number.isFinite(extraRaw) && extraRaw > 0 ? extraRaw : 0;
  const monthly = calculated.monthly + extra;
  const warnings = [...calculated.warnings];
  if (extra > 0) {
    warnings.push("К инфраструктуре прибавлены прочие расходы " + extra + " ₽/мес (PLATFORM_INFRA_EXTRA_PER_MONTH).");
  }
  return {
    configured: monthly > 0,
    source: "mts-price-list",
    fetchedAt: priceList.fetchedAt,
    stale: priceList.stale,
    currency: "RUB",
    monthly,
    compute: calculated.compute,
    disks: calculated.disks,
    network: calculated.network,
    extra,
    resources,
    rates: priceList.rates.filter(item => /Виртуальный процессор|Оперативная память|Объем сетевого диска|Активный внешний IP-адрес/.test(item.label)),
    warnings,
  };
}
