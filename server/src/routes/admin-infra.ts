import { execFile } from "node:child_process";
import { readFile, readdir, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { isYdbEnabled, ydbQuery } from "../storage/ydb.js";
import { listProjectOwners, type ProjectOwner } from "../project-store.js";
import { readProjectSizes } from "../account/storage-quota.js";
import { sandboxRootDir } from "../sandbox/config.js";
import { sandboxStatus } from "../docker-sandbox.js";
import { listPreviews } from "../preview/preview-store.js";
import { PREVIEW_LABEL } from "../preview/types.js";
import { lastProjectAccess } from "../storage/project-archive.js";
import { listArchiveRecords, type ProjectArchiveRecord } from "../storage/project-archive-state.js";
import { listUserIdentities } from "../auth/auth-store.js";
import { objectStoreConfigFromEnv, summarizeBucket } from "../storage/object-store.js";

/**
 * Инфраструктура платформы для админ-приложения: диск, Docker, песочницы, бакеты и база.
 *
 * Маршрут только читает и только по админ-токену. Он запускает `docker` и считает объекты в
 * бакете, поэтому снимок кэшируется на 15–30 секунд: обновление экрана не должно превращаться в
 * `docker ps` и обход S3 на каждое нажатие.
 *
 * Главное правило — не врать нулём. Если журнала холодных стартов нет, поле приходит `null`, а в
 * `unavailable` появляется причина. Если Docker не установлен, раздел `docker` говорит
 * `available: false`, а не показывает пустые контейнеры. Так экран честно показывает «не знаю»
 * вместо «всё хорошо».
 */

const CACHE_TTL_MS = clampNumber(Number(process.env.ADMIN_INFRA_CACHE_MS ?? 20_000), 15_000, 30_000);
const BUCKET_MAX_PAGES = clampNumber(Number(process.env.ADMIN_INFRA_BUCKET_MAX_PAGES ?? 10), 1, 100);
const DOCKER_TIMEOUT_MS = 5_000;

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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

function errorText(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return text.slice(0, 240) || "неизвестная ошибка";
}

function dataDir() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

function buildId() {
  return process.env.WEBNESTDEV_BUILD?.trim() || "dev";
}

async function isDirectory(target: string) {
  const info = await stat(target).catch(() => null);
  return Boolean(info?.isDirectory());
}

export type InfraUnavailable = { section: string; reason: string };
export type InfraAlert = { level: "warn" | "danger"; text: string };
export type DiskPressure = "ok" | "warn" | "danger";

export type InfraHost = {
  hostname: string;
  platform: string;
  nodeVersion: string;
  build: string;
  cpuCount: number;
  loadAverage: number[];
  uptimeSeconds: number;
  memory: { totalBytes: number; usedBytes: number };
  process: { rssBytes: number; heapUsedBytes: number };
};

export type InfraMount = {
  mount: string;
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

export type InfraDisk = {
  pressure: DiskPressure;
  mounts: InfraMount[];
  dockerBytes: number | null;
  reclaimableBytes: number | null;
};

export type InfraDocker = {
  available: boolean;
  version?: string;
  containers?: { running: number; paused: number; stopped: number; total: number };
  images?: { total: number; bytes: number | null };
  reclaimableBytes?: number | null;
};

export type InfraSandboxes = {
  projects: number;
  running: number;
  cold: number;
  neverStarted: number;
  coldStarts24h: number | null;
  averageStartMs: number | null;
  slowestStartMs: number | null;
  diskBytes: number | null;
};

export type InfraBucket = {
  name: string;
  provider: "s3";
  objects: number;
  bytes: number;
  updatedAt: string | null;
  truncated: boolean;
};

export type InfraTable = { name: string; rows: number; bytes: number | null };

export type InfraDatabase = {
  engine: "postgres";
  name: string;
  totalBytes: number | null;
  connections: number | null;
  lastBackupAt: string | null;
  tables: InfraTable[];
};

export type AdminSandboxState = "running" | "cold" | "never";
export type SandboxQueryState = AdminSandboxState | "all";

export type AdminSandboxRow = {
  projectId: string;
  name: string;
  email: string;
  state: AdminSandboxState;
  container: string;
  lastActiveAt: string;
  startedAt: string | null;
  startMs: number | null;
  /** Размер проекта; `null` — замера ещё нет. У проекта без файлов это честный ноль. */
  diskBytes: number | null;
};

export type InfraSnapshot = {
  generatedAt: string;
  host: InfraHost;
  disk?: InfraDisk;
  docker: InfraDocker;
  sandboxes?: InfraSandboxes;
  buckets: InfraBucket[];
  database?: InfraDatabase;
  alerts: InfraAlert[];
  unavailable: InfraUnavailable[];
};

/** Строка размера Docker (`1.5GB`, `0B`, `4.29GB (50%)`) — в байты. */
export function parseDockerSize(value: string): number | null {
  const match = /^\s*([\d]+(?:[.,]\d+)?)\s*([A-Za-z]+)?/.exec(value);
  if (!match) return null;
  const amount = Number(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  const units: Record<string, number> = {
    b: 1,
    kb: 1_000,
    mb: 1_000_000,
    gb: 1_000_000_000,
    tb: 1_000_000_000_000,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const factor = units[(match[2] ?? "b").toLowerCase()];
  return factor === undefined ? null : Math.round(amount * factor);
}

/** Порог диска считается по худшему разделу: место кончается там, где живут слои Docker. */
export function diskPressure(usedRatio: number): DiskPressure {
  if (usedRatio >= 0.9) return "danger";
  if (usedRatio >= 0.8) return "warn";
  return "ok";
}

export type DockerDfRow = {
  type: string;
  count: number | null;
  size: number | null;
  reclaimable: number | null;
};

/**
 * Разбор `docker system df`. Новый Docker отдаёт по строке JSON (`--format '{{json .}}'`), старый —
 * таблицу с колонками через два пробела. Оба варианта приводятся к одной строке: иначе на одной
 * ВМ экран показывал бы цифры, а на другой «—» из-за версии Docker.
 */
export function parseDockerDf(output: string): DockerDfRow[] {
  const rows: DockerDfRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      rows.push({
        type: String(value.Type ?? "").trim(),
        count: value.TotalCount === undefined ? null : num(value.TotalCount),
        size: value.Size === undefined ? null : parseDockerSize(String(value.Size)),
        reclaimable: value.Reclaimable === undefined ? null : parseDockerSize(String(value.Reclaimable)),
      });
    } catch {
      // Строка не JSON — возможно, это старый табличный вывод, его разберём ниже.
    }
  }
  if (rows.length) return rows;

  const lines = output.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || !/^TYPE\b/i.test(lines[0].trim())) return rows;
  for (const line of lines.slice(1)) {
    const columns = line.split(/\s{2,}/).map(column => column.trim()).filter(Boolean);
    if (columns.length < 4) continue;
    const [type, total, , size, reclaimable] = columns;
    rows.push({
      type,
      count: total === undefined ? null : num(total),
      size: parseDockerSize(size ?? ""),
      reclaimable: reclaimable === undefined ? null : parseDockerSize(reclaimable),
    });
  }
  return rows;
}

export type DockerDfSummary = {
  dockerBytes: number | null;
  reclaimableBytes: number | null;
  imagesBytes: number | null;
  imagesCount: number | null;
};

/** Суммы по строкам `docker system df`: неизвестная строка делает сумму неполной, а не нулевой. */
export function summarizeDockerDf(rows: DockerDfRow[]): DockerDfSummary {
  const complete = rows.length > 0 && rows.every(row => row.size !== null);
  const reclaimableComplete = rows.length > 0 && rows.every(row => row.reclaimable !== null);
  const images = rows.find(row => row.type.toLowerCase() === "images");
  return {
    dockerBytes: complete ? rows.reduce((sum, row) => sum + (row.size ?? 0), 0) : null,
    reclaimableBytes: reclaimableComplete ? rows.reduce((sum, row) => sum + (row.reclaimable ?? 0), 0) : null,
    imagesBytes: images?.size ?? null,
    imagesCount: images?.count ?? null,
  };
}

/** Разбор `docker ps -a --format '{{json .}}'`: только контейнеры предпросмотра. */
export function parseDockerContainers(output: string): Map<string, { name: string; state: "running" | "stopped" }> {
  const containers = new Map<string, { name: string; state: "running" | "stopped" }>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const labels = typeof row.Labels === "string" ? row.Labels : "";
    const label = PREVIEW_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const project = new RegExp("(?:^|,)" + label + "=([^,]+)").exec(labels);
    if (!project) continue;
    const names = typeof row.Names === "string" ? row.Names.split(",")[0]?.trim() ?? "" : "";
    const rawState = String(row.State ?? "").toLowerCase();
    const state = rawState === "running" || rawState === "restarting" ? "running" : "stopped";
    const name = names || String(row.ID ?? "");
    const previous = containers.get(project[1]);
    // У проекта мог остаться старый остановленный контейнер и появиться новый работающий:
    // показываем тот, который действительно работает.
    if (!previous || state === "running") containers.set(project[1], { name, state });
  }
  return containers;
}

export type MountInfo = { device: string; mount: string };

/** `/proc/mounts` с раскодированными пробелами и табуляцией в точках монтирования. */
export function parseProcMounts(text: string): MountInfo[] {
  const mounts: MountInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [device, mount] = line.split(" ");
    if (!device || !mount) continue;
    const decoded = mount.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    mounts.push({ device, mount: decoded });
  }
  return mounts;
}

/** Точка монтирования, на которой реально лежит путь: самая длинная подходящая. */
export function mountFor(target: string, mounts: MountInfo[]): MountInfo {
  let best: MountInfo | null = null;
  for (const item of mounts) {
    const prefix = item.mount.endsWith("/") ? item.mount : item.mount + "/";
    if (target !== item.mount && !target.startsWith(prefix)) continue;
    if (!best || item.mount.length > best.mount.length) best = item;
  }
  return best ?? { device: "", mount: target };
}

/**
 * Ряды песочниц для списка и агрегатов снимка.
 *
 * «Холодная» здесь — известная проекту песочница, которая не работает: рабочая папка на диске
 * или архив в бакете. В этой платформе контейнер предпросмотра удаляется при остановке, поэтому
 * остановленный контейнер — не единственный признак холода, иначе 34 холодных проекта выглядели
 * бы как 34 «никогда не запускавшихся». `never` — проекта нет ни на диске, ни в бакете.
 */
export type SandboxRowSource = {
  projects: ProjectOwner[];
  sizes: Map<string, { sizeBytes: number; updatedAt: string; lastWriteAt: string | null }>;
  archives: Map<string, ProjectArchiveRecord>;
  emails: Map<string, string>;
  directories: Set<string>;
  containers: Map<string, { name: string; state: "running" | "stopped" }>;
  previews: Map<string, { mode: "container" | "static"; startedAt: number; lastUsedAt: number }>;
  access: Map<string, number>;
  now: number;
};

function latestIso(values: Array<string | number | null | undefined>, fallback: number): string {
  let latest = 0;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const time = typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return new Date(latest || fallback).toISOString();
}

export function buildSandboxRows(source: SandboxRowSource): AdminSandboxRow[] {
  const rows: AdminSandboxRow[] = [];
  for (const project of source.projects) {
    const preview = source.previews.get(project.id);
    const container = source.containers.get(project.id);
    const archive = source.archives.get(project.id);
    const size = source.sizes.get(project.id);
    const running = Boolean(preview) || container?.state === "running";
    const onDisk = source.directories.has(project.id);
    const state: AdminSandboxState = running
      ? "running"
      : archive || onDisk || container
        ? "cold"
        : "never";
    // Размер берётся из замера, а для проекта, которого нет на диске, — из отметки архива.
    // Если рабочая папка есть, но замера нет, размер неизвестен: подставлять архив было бы
    // догадкой, а ноль — ложью. У «никогда не запускавшегося» проекта ноль настоящий.
    const measuredBytes = size?.sizeBytes ?? (onDisk ? null : archive?.bytes);
    rows.push({
      projectId: project.id,
      name: project.name,
      email: source.emails.get(project.userId) ?? "",
      state,
      container: container?.name ?? "",
      lastActiveAt: latestIso(
        [
          preview?.lastUsedAt,
          source.access.get(project.id),
          archive?.archivedAt,
          size?.lastWriteAt,
          size?.updatedAt,
          project.updatedAt,
        ],
        source.now,
      ),
      // Время старта измеряется только журналом, которого пока нет: ноль здесь был бы ложью.
      startedAt: preview ? new Date(preview.startedAt).toISOString() : null,
      startMs: null,
      diskBytes: measuredBytes ?? (state === "never" ? 0 : null),
    });
  }
  // Сортировка по последней активности: первыми идут те, кто вернётся скорее всего.
  rows.sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt) || left.name.localeCompare(right.name, "ru"));
  return rows;
}

export function filterSandboxRows(rows: AdminSandboxRow[], state: SandboxQueryState): AdminSandboxRow[] {
  return state === "all" ? [...rows] : rows.filter(row => row.state === state);
}

type SandboxInventory = {
  rows: AdminSandboxRow[];
  projects: number;
  sizes: Map<string, { sizeBytes: number; updatedAt: string; lastWriteAt: string | null }>;
  sizesReady: boolean;
  /** Состояние (running / cold / never) известно, только если прочитаны оба источника. */
  stateReady: boolean;
  issues: InfraUnavailable[];
};

/**
 * Единственный запуск docker: аргументы массивом, без шелла и без склейки строк. Экспортирован,
 * потому что им пользуется и очистка (routes/admin-prune.ts): второй такой же запускатель
 * разошёлся бы с этим в обработке отсутствующего Docker.
 */
export async function runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string } | null> {
  return new Promise(resolve => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(null);
        return;
      }
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

async function readPreviewContainers(): Promise<Map<string, { name: string; state: "running" | "stopped" }>> {
  const result = await runDocker(["ps", "-a", "--filter", "label=" + PREVIEW_LABEL, "--format", "{{json .}}"]);
  if (!result) throw new Error("Docker недоступен");
  if (result.code !== 0) throw new Error(result.stderr.trim() || "docker ps не ответил");
  return parseDockerContainers(result.stdout);
}

async function projectDirectoryIds(): Promise<Set<string>> {
  const root = sandboxRootDir();
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    // Каталога ещё нет — это нормальный старт без проектов; отказ в правах уже ошибка.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  return new Set(entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name));
}

async function collectSandboxInventory(): Promise<SandboxInventory> {
  const now = Date.now();
  const issues: InfraUnavailable[] = [];
  // Без списка проектов считать нечего: это единственный источник, ошибку которого нельзя заменить
  // пустым списком — иначе экран скажет «песочниц нет» вместо «не удалось прочитать».
  const projects = await withTimeout(listProjectOwners(), 5_000, "Список проектов не прочитан за 5 с");

  const [sizesResult, archivesResult, usersResult, containersResult, directoriesResult] = await Promise.allSettled([
    withTimeout(readProjectSizes(), 5_000, "Размеры проектов не прочитаны за 5 с"),
    withTimeout(listArchiveRecords(), 5_000, "Отметки холодного яруса не прочитаны за 5 с"),
    withTimeout(listUserIdentities(), 5_000, "Email аккаунтов не прочитаны за 5 с"),
    withTimeout(readPreviewContainers(), 8_000, "Docker не ответил за 8 с"),
    withTimeout(projectDirectoryIds(), 5_000, "Каталог песочниц не прочитан за 5 с"),
  ]);

  const sizes = sizesResult.status === "fulfilled" ? sizesResult.value : new Map();
  if (sizesResult.status === "rejected") {
    issues.push({ section: "sandboxes.diskBytes", reason: "размеры проектов не прочитаны: " + errorText(sizesResult.reason) });
  }
  const archives = new Map<string, ProjectArchiveRecord>();
  if (archivesResult.status === "fulfilled") {
    for (const record of archivesResult.value) archives.set(record.projectId, record);
  } else {
    issues.push({ section: "sandboxes.cold", reason: "отметки холодного яруса не прочитаны: " + errorText(archivesResult.reason) });
  }
  const emails = new Map<string, string>();
  if (usersResult.status === "fulfilled") {
    for (const user of usersResult.value) emails.set(user.id, user.email);
  } else {
    issues.push({ section: "sandboxes.email", reason: "email аккаунтов не прочитаны: " + errorText(usersResult.reason) });
  }
  let containers = new Map<string, { name: string; state: "running" | "stopped" }>();
  if (containersResult.status === "fulfilled") {
    containers = containersResult.value;
  } else {
    issues.push({ section: "docker.containers", reason: "контейнеры предпросмотра не прочитаны: " + errorText(containersResult.reason) });
  }
  let directories = new Set<string>();
  if (directoriesResult.status === "fulfilled") {
    directories = directoriesResult.value;
  } else {
    issues.push({ section: "sandboxes", reason: "каталог песочниц не прочитан: " + errorText(directoriesResult.reason) });
  }

  const previews = new Map<string, { mode: "container" | "static"; startedAt: number; lastUsedAt: number }>();
  for (const preview of listPreviews()) {
    previews.set(preview.projectId, { mode: preview.mode, startedAt: preview.startedAt, lastUsedAt: preview.lastUsedAt });
  }
  const access = new Map<string, number>();
  for (const project of projects) access.set(project.id, lastProjectAccess(project.id));

  return {
    rows: buildSandboxRows({ projects, sizes, archives, emails, directories, containers, previews, access, now }),
    projects: projects.length,
    sizes,
    sizesReady: sizesResult.status === "fulfilled",
    stateReady: archivesResult.status === "fulfilled" && containersResult.status === "fulfilled" && directoriesResult.status === "fulfilled",
    issues,
  };
}

async function collectDocker(): Promise<{ docker: InfraDocker; issues: InfraUnavailable[]; df: DockerDfSummary | null }> {
  const issues: InfraUnavailable[] = [];
  const status: Awaited<ReturnType<typeof sandboxStatus>> = await withTimeout(sandboxStatus(), 4_000, "Docker не ответил за 4 с").catch(error => ({
    mode: process.env.SANDBOX_MODE ?? "docker",
    available: false,
    detail: errorText(error),
  }));
  if (!status.available) {
    return {
      docker: { available: false },
      issues: [{ section: "docker", reason: status.detail ?? status.reason ?? "Docker недоступен" }],
      df: null,
    };
  }

  const docker: InfraDocker = { available: true, ...(status.dockerVersion ? { version: status.dockerVersion } : {}) };

  // Два независимых запроса к Docker идут вместе: последовательные ожидания на зависшем демоне
  // складываются, и админ-экран ждал бы два таймаута вместо одного.
  const [ps, df] = await Promise.all([runDocker(["ps", "-a", "--format", "{{.State}}"]), collectDockerDf()]);
  if (ps && ps.code === 0) {
    const states = ps.stdout.split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(Boolean);
    const containers = { running: 0, paused: 0, stopped: 0, total: states.length };
    for (const state of states) {
      if (state === "running" || state === "restarting") containers.running++;
      else if (state === "paused") containers.paused++;
      else containers.stopped++;
    }
    docker.containers = containers;
  } else {
    issues.push({ section: "docker.containers", reason: ps ? ps.stderr.trim() || "docker ps не ответил" : "Docker недоступен" });
  }

  if (df.summary) {
    docker.reclaimableBytes = df.summary.reclaimableBytes;
    if (df.summary.reclaimableBytes === null) {
      issues.push({ section: "docker.reclaimableBytes", reason: "часть строк docker system df не разобрана — сумма к освобождению неполная" });
    }
    if (df.summary.imagesCount !== null) {
      docker.images = { total: df.summary.imagesCount, bytes: df.summary.imagesBytes };
      if (df.summary.imagesBytes === null) {
        issues.push({ section: "docker.images.bytes", reason: "размер образов не разобран в docker system df" });
      }
    }
  } else {
    issues.push({ section: "docker.images", reason: df.reason ?? "docker system df не ответил" });
  }
  return { docker, issues, df: df.summary };
}

async function collectDockerDf(): Promise<{ summary: DockerDfSummary | null; reason?: string }> {
  const json = await runDocker(["system", "df", "--format", "{{json .}}"]);
  if (json && json.code === 0) {
    const rows = parseDockerDf(json.stdout);
    if (rows.length) return { summary: summarizeDockerDf(rows) };
  }
  // Старый Docker не знает `--format` у `system df`; таблица разбирается тем же кодом.
  const plain = await runDocker(["system", "df"]);
  if (plain && plain.code === 0) {
    const rows = parseDockerDf(plain.stdout);
    if (rows.length) return { summary: summarizeDockerDf(rows) };
  }
  return { summary: null, reason: plain?.stderr.trim() || json?.stderr.trim() || "docker system df не ответил" };
}

async function collectDisk(df: DockerDfSummary | null): Promise<{ disk?: InfraDisk; issues: InfraUnavailable[] }> {
  const issues: InfraUnavailable[] = [];
  const mountsInfo = parseProcMounts(await readFile("/proc/mounts", "utf8").catch(() => ""));
  const candidates = ["/"];
  if (await isDirectory("/var/lib/docker")) candidates.push("/var/lib/docker");
  for (const candidate of [sandboxRootDir(), dataDir()]) {
    if (await isDirectory(candidate)) candidates.push(candidate);
  }

  const seen = new Set<string>();
  const mounts: InfraMount[] = [];
  for (const candidate of candidates) {
    const target = mountFor(candidate, mountsInfo);
    if (seen.has(target.mount)) continue;
    try {
      const info = await statfs(candidate);
      const blockSize = Number(info.bsize);
      const totalBytes = Number(info.blocks) * blockSize;
      if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
      const usedBytes = Math.max(0, (Number(info.blocks) - Number(info.bfree)) * blockSize);
      const freeBytes = Math.max(0, Number(info.bavail) * blockSize);
      mounts.push({ mount: target.mount, filesystem: target.device, totalBytes, usedBytes, freeBytes });
      seen.add(target.mount);
    } catch {
      // Раздел мог исчезнуть между чтением /proc/mounts и statfs — это не повод терять остальные.
    }
  }

  if (!mounts.length) {
    return { issues: [{ section: "disk", reason: "не удалось измерить ни один раздел (statfs / /proc/mounts)" }] };
  }

  const worst = mounts.reduce((max, mount) => Math.max(max, mount.totalBytes > 0 ? mount.usedBytes / mount.totalBytes : 0), 0);
  const disk: InfraDisk = {
    pressure: diskPressure(worst),
    mounts,
    dockerBytes: df?.dockerBytes ?? null,
    reclaimableBytes: df?.reclaimableBytes ?? null,
  };
  if (!df) {
    issues.push({ section: "disk.dockerBytes", reason: "Docker не отдал размер своих данных — сумма по разделам не включает образы и тома" });
  } else {
    if (df.dockerBytes === null) {
      issues.push({ section: "disk.dockerBytes", reason: "часть строк docker system df не разобрана — размер Docker неполный" });
    }
    if (df.reclaimableBytes === null) {
      issues.push({ section: "disk.reclaimableBytes", reason: "часть строк docker system df не разобрана — сумма к освобождению неполная" });
    }
  }
  return { disk, issues };
}

async function collectBuckets(): Promise<{ buckets: InfraBucket[]; issues: InfraUnavailable[]; failed: boolean }> {
  let config: ReturnType<typeof objectStoreConfigFromEnv>;
  try {
    config = objectStoreConfigFromEnv();
  } catch (error) {
    return { buckets: [], issues: [{ section: "buckets", reason: "объектное хранилище настроено не полностью: " + errorText(error) }], failed: true };
  }
  if (!config) {
    return { buckets: [], issues: [{ section: "buckets", reason: "объектное хранилище не настроено (PLATFORM_S3_*) — холодный ярус проектов выключен" }], failed: false };
  }
  try {
    const summary = await summarizeBucket(config, {}, { maxPages: BUCKET_MAX_PAGES, timeoutMs: 10_000 });
    if (!summary) return { buckets: [], issues: [{ section: "buckets", reason: "объектное хранилище не настроено" }], failed: false };
    return {
      buckets: [{ name: config.bucket, provider: "s3", objects: summary.objects, bytes: summary.bytes, updatedAt: null, truncated: summary.truncated }],
      issues: [],
      failed: false,
    };
  } catch (error) {
    return { buckets: [], issues: [{ section: "buckets", reason: "бакет не удалось посчитать: " + errorText(error) }], failed: true };
  }
}

async function collectDatabase(): Promise<{ database?: InfraDatabase; issues: InfraUnavailable[] }> {
  if (!isYdbEnabled()) {
    return { issues: [{ section: "database", reason: "хранилище JSON — отдельной базы данных нет" }] };
  }
  try {
    const [rows] = await withTimeout(
      ydbQuery()<Array<{ name: string; total_bytes: unknown; connections: unknown }>>`
        SELECT current_database() AS name,
               pg_database_size(current_database()) AS total_bytes,
               (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connections
      `,
      5_000,
      "База не ответила за 5 с",
    );
    const [tables] = await withTimeout(
      ydbQuery()<Array<{ name: string; live_rows: unknown; bytes: unknown }>>`
        SELECT c.relname AS name,
               COALESCE(s.n_live_tup, 0) AS live_rows,
               pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE c.relkind = 'r' AND n.nspname = current_schema()
        ORDER BY pg_total_relation_size(c.oid) DESC
      `,
      5_000,
      "База не ответила за 5 с",
    );
    const first = rows[0];
    return {
      database: {
        engine: "postgres",
        name: first?.name ?? "",
        totalBytes: first ? num(first.total_bytes) : null,
        connections: first ? num(first.connections) : null,
        lastBackupAt: null,
        tables: tables.map(table => ({ name: table.name, rows: num(table.live_rows), bytes: num(table.bytes) })),
      },
      issues: [
        { section: "database.lastBackupAt", reason: "журнала резервных копий нет — дата последней копии не измеряется" },
      ],
    };
  } catch (error) {
    return { issues: [{ section: "database", reason: "база не ответила: " + errorText(error) }] };
  }
}

function hostSnapshot(): InfraHost {
  const memory = process.memoryUsage();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform() + " " + os.arch(),
    nodeVersion: process.version,
    build: buildId(),
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    uptimeSeconds: Math.round(os.uptime()),
    memory: { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes) },
    process: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
  };
}

export async function buildInfraSnapshot(
  inventory: SandboxInventory | null,
  inventoryIssues: InfraUnavailable[] = [],
): Promise<InfraSnapshot> {
  const unavailable: InfraUnavailable[] = [];
  const sections = new Set<string>();
  const mark = (section: string, reason: string) => {
    if (sections.has(section)) return;
    sections.add(section);
    unavailable.push({ section, reason });
  };
  for (const issue of inventoryIssues) mark(issue.section, issue.reason);

  const host = hostSnapshot();
  const [dockerProbe, bucketProbe, databaseProbe] = await Promise.all([collectDocker(), collectBuckets(), collectDatabase()]);
  const diskProbe = await collectDisk(dockerProbe.df);
  for (const issue of dockerProbe.issues) mark(issue.section, issue.reason);
  for (const issue of diskProbe.issues) mark(issue.section, issue.reason);
  for (const issue of bucketProbe.issues) mark(issue.section, issue.reason);
  for (const issue of databaseProbe.issues) mark(issue.section, issue.reason);

  let sandboxes: InfraSandboxes | undefined;
  if (inventory && !inventory.stateReady) {
    mark("sandboxes", "состояние песочниц не прочитано: нет части источников (архивы, контейнеры или каталог) — счётчики не выдумываются");
  } else if (inventory) {
    const rows = inventory.rows;
    // Сумма честная только тогда, когда размер известен у каждого проекта. Частичная сумма
    // выглядела бы как полная и занижала бы занятое место ровно там, где это важно.
    const unknownDisk = !inventory.sizesReady || rows.some(row => row.diskBytes === null);
    if (unknownDisk) {
      mark(
        "sandboxes.diskBytes",
        inventory.sizesReady
          ? "размер части проектов ещё не измерен — сумма по песочницам неполная"
          : "размеры проектов не прочитаны — сумма по песочницам неизвестна",
      );
    }
    mark("sandboxes.coldStarts24h", "журнала холодных стартов нет — счётчик за сутки не ведётся");
    mark("sandboxes.averageStartMs", "журнала холодных стартов нет — среднее время старта не измеряется");
    mark("sandboxes.slowestStartMs", "журнала холодных стартов нет — самое долгое время старта не измеряется");
    sandboxes = {
      projects: inventory.projects,
      running: rows.filter(row => row.state === "running").length,
      cold: rows.filter(row => row.state === "cold").length,
      neverStarted: rows.filter(row => row.state === "never").length,
      coldStarts24h: null,
      averageStartMs: null,
      slowestStartMs: null,
      diskBytes: unknownDisk ? null : rows.reduce((sum, row) => sum + (row.diskBytes ?? 0), 0),
    };
  }

  const alerts: InfraAlert[] = [];
  const alert = (level: InfraAlert["level"], text: string) => {
    if (alerts.length < 5) alerts.push({ level, text });
  };
  if (diskProbe.disk) {
    const worst = diskProbe.disk.mounts.reduce(
      (best, mount) => (mount.totalBytes > 0 && mount.usedBytes / mount.totalBytes > best.ratio ? { mount, ratio: mount.usedBytes / mount.totalBytes } : best),
      { mount: diskProbe.disk.mounts[0], ratio: 0 },
    );
    const percent = Math.round(worst.ratio * 100);
    if (worst.ratio >= 0.9) alert("danger", "Раздел " + worst.mount.mount + " занят на " + percent + "% — записи и сборки могут упасть");
    else if (worst.ratio >= 0.8) alert("warn", "Раздел " + worst.mount.mount + " занят на " + percent + "% — образы Docker займут его первыми");
  }
  if (!dockerProbe.docker.available) alert("warn", "Docker недоступен: песочницы и предпросмотры не запустятся");
  const memoryRatio = host.memory.totalBytes > 0 ? host.memory.usedBytes / host.memory.totalBytes : 0;
  if (memoryRatio >= 0.9) alert("warn", "Память хоста занята на " + Math.round(memoryRatio * 100) + "% — контейнерам может не хватить");
  if (bucketProbe.failed) alert("warn", "Бакет проектов не отвечает: холодный ярус недоступен");
  if (isYdbEnabled() && databaseProbe.issues.some(issue => issue.section === "database")) {
    alert("warn", "База данных не отвечает: часть цифр недоступна");
  }

  return {
    generatedAt: new Date().toISOString(),
    host,
    ...(diskProbe.disk ? { disk: diskProbe.disk } : {}),
    docker: dockerProbe.docker,
    ...(sandboxes ? { sandboxes } : {}),
    buckets: bucketProbe.buckets,
    ...(databaseProbe.database ? { database: databaseProbe.database } : {}),
    alerts,
    unavailable,
  };
}

let inventoryCache: { at: number; value: SandboxInventory } | null = null;
let inventoryPending: Promise<SandboxInventory> | null = null;

async function getSandboxInventory(): Promise<SandboxInventory> {
  if (inventoryCache && Date.now() - inventoryCache.at < CACHE_TTL_MS) return inventoryCache.value;
  if (inventoryPending) return inventoryPending;
  inventoryPending = collectSandboxInventory()
    .then(value => {
      inventoryCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inventoryPending = null;
    });
  return inventoryPending;
}

let snapshotCache: { at: number; value: InfraSnapshot } | null = null;
let snapshotPending: Promise<InfraSnapshot> | null = null;

async function getInfraSnapshot(): Promise<InfraSnapshot> {
  if (snapshotCache && Date.now() - snapshotCache.at < CACHE_TTL_MS) return snapshotCache.value;
  if (snapshotPending) return snapshotPending;
  snapshotPending = (async () => {
    const issues: InfraUnavailable[] = [];
    let inventory: SandboxInventory | null = null;
    try {
      inventory = await getSandboxInventory();
      issues.push(...inventory.issues);
    } catch (error) {
      issues.push({ section: "sandboxes", reason: "песочницы не прочитаны: " + errorText(error) });
    }
    const snapshot = await buildInfraSnapshot(inventory, issues);
    snapshotCache = { at: Date.now(), value: snapshot };
    return snapshot;
  })().finally(() => {
    snapshotPending = null;
  });
  return snapshotPending;
}

const sandboxesQuery = z.object({
  state: z.enum(["cold", "running", "never", "all"]).default("cold"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerAdminInfraRoutes(app: FastifyInstance) {
  /**
   * Снимок инфраструктуры. Тяжёлые пробы (Docker, бакет, база) кэшируются вместе со списком
   * песочниц; `generatedAt` — время именно этого снимка, а не ответа из кэша.
   */
  app.get("/api/admin/infra", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);
    return getInfraSnapshot();
  });

  /**
   * Песочницы списком. `total` считается до `limit`: экран показывает «34 холодных» и первые 50,
   * а не «50 холодных», если на хосте их больше.
   */
  app.get("/api/admin/sandboxes", async (request, reply) => {
    const auth = await requireAdmin(request, reply);
    if (!auth) return;
    applyNoStoreToReply(reply);

    const parsed = sandboxesQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Некорректный запрос" });
    }
    let inventory: SandboxInventory;
    try {
      inventory = await getSandboxInventory();
    } catch (error) {
      return reply.code(503).send({ error: "Не удалось прочитать песочницы: " + errorText(error) });
    }
    if (!inventory.stateReady) {
      const reasons = inventory.issues
        .filter(issue => issue.section === "sandboxes" || issue.section === "sandboxes.cold" || issue.section === "docker.containers")
        .map(issue => issue.reason);
      return reply.code(503).send({ error: "Состояние песочниц неизвестно: " + (reasons.join("; ") || "не прочитаны источники состояния") });
    }
    const rows = filterSandboxRows(inventory.rows, parsed.data.state);
    return { total: rows.length, sandboxes: rows.slice(0, parsed.data.limit) };
  });
}
