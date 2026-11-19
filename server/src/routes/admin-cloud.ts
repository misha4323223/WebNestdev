import type { FastifyInstance } from "fastify";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { mwsProject, mwsRequest } from "../mws/mws-auth.js";
import { listS3Buckets } from "../services/s3.js";
import { objectStoreConfigFromEnv } from "../storage/object-store.js";

/**
 * Обзор облака МТС для внешней админки: машины, диски, внешние адреса и бакеты — без консоли.
 *
 * Маршрут только читает и только по админ-токену. Ключ сервисного аккаунта остаётся на сервере:
 * приложение админки не получает ни его, ни IAM-токен. Список бакетов читается HMAC-ключами
 * `PLATFORM_S3_*` через S3 `ListBuckets`; у MWS нет отдельного REST-метода для этой операции.
 *
 * Секции независимы. Если Compute ответил, а VPC нет, машины и диски остаются, а причина по
 * адресам попадает в `unavailable`; `totals` для непрочитанной секции приходит `null`, а не
 * нулём — ноль означал бы «ресурсов правда нет».
 */

const CACHE_TTL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type CloudPower = "ON" | "OFF" | "UNKNOWN";

export type CloudMachineDisk = {
  id: string;
  name: string;
  sizeBytes: number | null;
  type: string | null;
  boot: boolean;
  iops: number | null;
};

export type CloudMachineAddress = {
  internalIp: string | null;
  externalIp: string | null;
  externalRef: string | null;
};

export type CloudMachine = {
  id: string;
  path: string;
  name: string;
  zone: string;
  power: CloudPower;
  state: string;
  vmType: string;
  vcpu: number | null;
  ramMb: number | null;
  createdAt: string | null;
  disks: CloudMachineDisk[];
  addresses: CloudMachineAddress[];
};

export type CloudDisk = {
  id: string;
  path: string;
  name: string;
  zone: string;
  sizeBytes: number | null;
  type: string | null;
  iops: number | null;
  state: string;
  createdAt: string | null;
  attachedTo: Array<{ id: string; name: string }>;
};

export type CloudAddress = {
  id: string;
  path: string;
  name: string;
  displayName: string;
  ipAddress: string | null;
  active: boolean;
  region: string;
  createdAt: string | null;
  attachedTo: string | null;
};

export type CloudBucket = {
  name: string;
  configured: boolean;
};

export type CloudOverview = {
  generatedAt: string;
  configured: boolean;
  project: string | null;
  machines: CloudMachine[];
  disks: CloudDisk[];
  addresses: CloudAddress[];
  buckets: CloudBucket[];
  totals: {
    machines: number | null;
    runningMachines: number | null;
    disks: number | null;
    diskBytes: number | null;
    addresses: number | null;
    activeAddresses: number | null;
    buckets: number | null;
  };
  unavailable: Array<{ section: string; reason: string }>;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : null;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === "t" || value === 1 || value === "1";
}

function listOf(body: unknown): unknown[] {
  const value = record(body);
  if (!value) return [];
  if (Array.isArray(value.items)) return value.items;
  const arrays = Object.values(value).filter(Array.isArray);
  return arrays[0] ?? [];
}

function shortRef(value: unknown): string {
  return text(value).split("/").filter(Boolean).at(-1) ?? "";
}

function pathOf(value: unknown, service: string, project: string, kind: string): string {
  const raw = text(value);
  if (!raw) return "";
  if (raw.startsWith(service + "/")) return raw;
  if (raw.startsWith("projects/")) return service + "/" + raw;
  return service + "/projects/" + project + "/" + kind + "/" + raw;
}

/** Размер MWS (`20GB`, `50 GB`, `1.5 TB`) в байтах. Null — размер не разобран. */
export function cloudSizeToBytes(value: unknown): number | null {
  const match = /^([\d]+(?:[.,]\d+)?)\s*(B|KB|MB|GB|TB)?$/i.exec(text(value));
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const units: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(amount * (units[(match[2] ?? "B").toUpperCase()] ?? 1));
}

function vmTypeOf(value: unknown): { name: string; vcpu: number | null; ramMb: number | null } {
  const name = shortRef(value);
  const match = /^([a-z][a-z0-9]*)-(\d+)-(\d+)$/i.exec(name);
  if (!match) return { name, vcpu: null, ramMb: null };
  const vcpu = Number(match[2]);
  const ramGb = Number(match[3]);
  return {
    name,
    vcpu: Number.isFinite(vcpu) && vcpu > 0 ? vcpu : null,
    ramMb: Number.isFinite(ramGb) && ramGb > 0 ? Math.round(ramGb * 1024) : null,
  };
}

function diskTypeOf(value: unknown): string {
  return shortRef(value);
}

function readinessOf(value: unknown): string {
  return text(record(value)?.state).toUpperCase();
}

/** Диски проекта. Экспортируется для тестов без сети. */
export function parseCloudDisks(body: unknown, project: string): CloudDisk[] {
  const disks: CloudDisk[] = [];
  for (const item of listOf(body)) {
    const disk = record(item);
    if (!disk) continue;
    const metadata = record(disk.metadata);
    if (!metadata) continue;
    const spec = record(disk.spec);
    const status = record(disk.status);
    const id = shortRef(metadata.name ?? metadata.id);
    if (!id) continue;
    const linked = Array.isArray(status?.linkedVms) ? status.linkedVms : [];
    const iopsValue = record(status?.iops)?.total ?? spec?.iops;
    const iops = Number(iopsValue ?? 0);
    disks.push({
      id,
      path: pathOf(metadata.id, "compute", project, "disks") || "compute/projects/" + project + "/disks/" + id,
      name: text(metadata.name) || id,
      zone: text(spec?.zone) || text(status?.zone),
      sizeBytes: cloudSizeToBytes(status?.size) ?? cloudSizeToBytes(spec?.size),
      type: diskTypeOf(status?.diskType ?? spec?.diskType) || null,
      iops: Number.isFinite(iops) && iops > 0 ? iops : null,
      state: readinessOf(status?.ready),
      createdAt: text(metadata.createTime) || null,
      attachedTo: linked.flatMap(value => {
        const vm = record(value);
        const vmId = shortRef(vm?.name ?? vm?.id);
        return vmId ? [{ id: vmId, name: text(vm?.name) || vmId }] : [];
      }),
    });
  }
  return disks;
}

/** Внешние IP-адреса проекта. Экспортируется для тестов без сети. */
export function parseCloudAddresses(body: unknown, project: string): CloudAddress[] {
  const addresses: CloudAddress[] = [];
  for (const item of listOf(body)) {
    const address = record(item);
    if (!address) continue;
    const metadata = record(address.metadata);
    if (!metadata) continue;
    const status = record(address.status);
    const id = shortRef(metadata.name ?? metadata.id);
    if (!id) continue;
    const usages = Array.isArray(metadata.usages) ? metadata.usages : [];
    const attachedTo = usages
      .map(value => record(value))
      .map(value => text(value?.resource))
      .find(Boolean) ?? null;
    addresses.push({
      id,
      path: pathOf(metadata.id, "vpc", project, "externalAddresses") || "vpc/projects/" + project + "/externalAddresses/" + id,
      name: text(metadata.name) || id,
      displayName: text(metadata.displayName) || text(metadata.name) || id,
      ipAddress: text(status?.ipAddress) || null,
      active: bool(status?.active),
      region: shortRef(status?.region) || shortRef(record(address.spec)?.region),
      createdAt: text(metadata.createTime) || null,
      attachedTo,
    });
  }
  return addresses;
}

/** Виртуальные машины проекта. Экспортируется для тестов без сети. */
export function parseCloudMachines(body: unknown, project: string, disks: CloudDisk[] = []): CloudMachine[] {
  const byPath = new Map(disks.map(disk => [disk.path, disk]));
  const machines: CloudMachine[] = [];
  for (const item of listOf(body)) {
    const machine = record(item);
    if (!machine) continue;
    const metadata = record(machine.metadata);
    if (!metadata) continue;
    const spec = record(machine.spec);
    const status = record(machine.status);
    const id = shortRef(metadata.name ?? metadata.id);
    if (!id) continue;
    const type = vmTypeOf(spec?.vmType);
    const powerRaw = text(record(status?.hardware)?.power ?? record(spec?.hardware)?.power).toUpperCase();
    const power: CloudPower = powerRaw === "ON" || powerRaw === "OFF" ? powerRaw : "UNKNOWN";

    const machineDisks: CloudMachineDisk[] = [];
    const statusStorage = record(status?.storage);
    const statusDisks = Array.isArray(statusStorage?.disks) ? statusStorage.disks : [];
    for (const raw of statusDisks) {
      const disk = record(raw);
      if (!disk) continue;
      const path = pathOf(disk.ref, "compute", project, "disks");
      const known = byPath.get(path);
      const diskId = known?.id ?? shortRef(disk.ref) ?? shortRef(disk.name);
      if (!diskId) continue;
      const iops = Number(disk.iops ?? 0);
      machineDisks.push({
        id: diskId,
        name: text(disk.name) || diskId,
        sizeBytes: cloudSizeToBytes(disk.size) ?? known?.sizeBytes ?? null,
        type: known?.type ?? null,
        boot: bool(disk.boot),
        iops: Number.isFinite(iops) && iops > 0 ? iops : known?.iops ?? null,
      });
    }

    const machineAddresses: CloudMachineAddress[] = [];
    const networks = Array.isArray(record(status?.network)?.networkInterfaces)
      ? record(status?.network)?.networkInterfaces as unknown[]
      : [];
    for (const raw of networks) {
      const iface = record(raw);
      if (!iface) continue;
      const addresses = Array.isArray(iface.addresses) ? iface.addresses : [];
      for (const rawAddress of addresses) {
        const address = record(rawAddress);
        if (!address) continue;
        const nat = record(address.oneToOneNat);
        const natExternal = record(nat?.external);
        const externalAddress = record(natExternal?.address);
        machineAddresses.push({
          internalIp: text(address.ipAddress) || null,
          externalIp: text(natExternal?.ipAddress) || text(externalAddress?.ipAddress) || null,
          externalRef: text(natExternal?.ref) || text(externalAddress?.ref) || null,
        });
      }
    }

    machines.push({
      id,
      path: pathOf(metadata.id, "compute", project, "virtualMachines") || "compute/projects/" + project + "/virtualMachines/" + id,
      name: text(metadata.displayName) || text(metadata.name) || id,
      zone: text(spec?.zone) || text(status?.zone),
      power,
      state: readinessOf(status?.ready),
      vmType: type.name,
      vcpu: type.vcpu,
      ramMb: type.ramMb,
      createdAt: text(metadata.createTime) || null,
      disks: machineDisks,
      addresses: machineAddresses,
    });
  }
  return machines;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function mwsItems(path: string) {
  const response = await withTimeout(mwsRequest({ path }), REQUEST_TIMEOUT_MS, "MWS не ответил за 10 с");
  if (!response.ok) {
    const detail = typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {});
    throw new Error("MWS вернул HTTP " + response.status + ": " + detail.slice(0, 300));
  }
  return response.body;
}

async function readBuckets() {
  // Конфиг читается внутри промиса: частично заполненные PLATFORM_S3_* должны попасть в
  // `unavailable`, а не оборвать весь обзор облака синхронным исключением.
  const config = objectStoreConfigFromEnv();
  if (!config) throw new Error("S3-ключи платформы не настроены: нужны PLATFORM_S3_ENDPOINT, PLATFORM_S3_BUCKET, PLATFORM_S3_ACCESS_KEY_ID и PLATFORM_S3_SECRET_ACCESS_KEY");
  const result = await listS3Buckets({
    endpoint: config.endpoint,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
  return result.buckets;
}

let cache: { at: number; value: CloudOverview } | null = null;
let pending: Promise<CloudOverview> | null = null;

export async function cloudOverview(now = Date.now()): Promise<CloudOverview> {
  const unavailable: CloudOverview["unavailable"] = [];
  let project: string | null = null;
  try {
    project = await mwsProject();
  } catch (error) {
    unavailable.push({ section: "cloud", reason: "ключ MWS не разобран: " + errorText(error) });
  }
  if (!project) {
    if (!unavailable.length) {
      unavailable.push({ section: "cloud", reason: "MWS не настроен: задайте MWS_SA_KEY или MWS_SA_KEY_ID + MWS_SA_PRIVATE_KEY" });
    }
    return {
      generatedAt: new Date(now).toISOString(),
      configured: false,
      project: null,
      machines: [],
      disks: [],
      addresses: [],
      buckets: [],
      totals: {
        machines: null,
        runningMachines: null,
        disks: null,
        diskBytes: null,
        addresses: null,
        activeAddresses: null,
        buckets: null,
      },
      unavailable,
    };
  }

  const base = "/projects/" + encodeURIComponent(project);
  const [machinesProbe, disksProbe, addressesProbe, bucketsProbe] = await Promise.allSettled([
    mwsItems("/compute/v1" + base + "/virtualMachines"),
    mwsItems("/compute/v1" + base + "/disks"),
    mwsItems("/vpc/v1" + base + "/externalAddresses"),
    readBuckets(),
  ]);

  const disks = disksProbe.status === "fulfilled" ? parseCloudDisks(disksProbe.value, project) : [];
  const machines = machinesProbe.status === "fulfilled" ? parseCloudMachines(machinesProbe.value, project, disks) : [];
  const addresses = addressesProbe.status === "fulfilled" ? parseCloudAddresses(addressesProbe.value, project) : [];
  const bucketNames = bucketsProbe.status === "fulfilled" ? bucketsProbe.value : [];

  if (machinesProbe.status === "rejected") unavailable.push({ section: "cloud.machines", reason: errorText(machinesProbe.reason) });
  if (disksProbe.status === "rejected") unavailable.push({ section: "cloud.disks", reason: errorText(disksProbe.reason) });
  if (addressesProbe.status === "rejected") unavailable.push({ section: "cloud.addresses", reason: errorText(addressesProbe.reason) });
  if (bucketsProbe.status === "rejected") unavailable.push({ section: "cloud.buckets", reason: errorText(bucketsProbe.reason) });

  let configuredBucket = "";
  try {
    configuredBucket = objectStoreConfigFromEnv()?.bucket ?? "";
  } catch {
    // Частично заполненные PLATFORM_S3_* уже попали в unavailable выше; список бакетов не читается.
  }

  const knownDiskBytes = disks.every(disk => disk.sizeBytes !== null)
    ? disks.reduce((sum, disk) => sum + (disk.sizeBytes ?? 0), 0)
    : null;

  return {
    generatedAt: new Date(now).toISOString(),
    configured: true,
    project,
    machines,
    disks,
    addresses,
    buckets: bucketNames.map(name => ({ name, configured: name === configuredBucket })),
    totals: {
      machines: machinesProbe.status === "fulfilled" ? machines.length : null,
      runningMachines: machinesProbe.status === "fulfilled" ? machines.filter(machine => machine.power === "ON").length : null,
      disks: disksProbe.status === "fulfilled" ? disks.length : null,
      diskBytes: disksProbe.status === "fulfilled" ? knownDiskBytes : null,
      addresses: addressesProbe.status === "fulfilled" ? addresses.length : null,
      activeAddresses: addressesProbe.status === "fulfilled" ? addresses.filter(address => address.active).length : null,
      buckets: bucketsProbe.status === "fulfilled" ? bucketNames.length : null,
    },
    unavailable,
  };
}

async function cachedCloudOverview(): Promise<CloudOverview> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (pending) return pending;
  pending = cloudOverview()
    .then(value => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Смена ключей/прав должна быть видна без ожидания кеша; тесты тоже начинают с чистого листа. */
export function resetCloudOverviewCacheForTests(): void {
  cache = null;
  pending = null;
}

export async function registerAdminCloudRoutes(app: FastifyInstance) {
  app.get("/api/admin/cloud/overview", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return cachedCloudOverview();
  });
}
