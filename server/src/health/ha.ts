import { readFile } from "node:fs/promises";
import path from "node:path";
import { HEALTH_THRESHOLDS, type HealthCheck } from "./thresholds.js";

/**
 * Снимки пишет failover-контроллер на каждой ноде (`deploy/ha/status.py`) в общий Gluster
 * `data/`. API не ходит в `pg_stat_replication` под своей ролью и не читает systemd:
 * он только сравнивает два файла. Если файлов нет, это не HA-развёртывание (dev/JSON),
 * и проверки не добавляются — иначе локальная разработка получала бы ложные алерты.
 */

export type HaNodeStatus = {
  node: string;
  updatedAt?: string;
  updatedAtUnix?: number;
  role?: "primary" | "standby" | "unknown";
  phase?: string;
  peerReachable?: boolean;
  replicationStreams?: number | null;
  replicationLagBytes?: number | null;
  walReceiverStatus?: string | null;
  archiveReady?: boolean | null;
  servicesStarted?: boolean;
};

const NODES = ["node-1", "node-2"] as const;

function dataDir(): string {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

async function readOne(dir: string, node: string): Promise<HaNodeStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, `ha-status-${node}.json`), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return { ...parsed, node: typeof parsed.node === "string" ? parsed.node : node };
  } catch {
    return null;
  }
}

/** Прочитать оба снимка; отсутствующий файл — это `null`, а не ошибка всего health. */
export async function readHaStatuses(dir = dataDir()): Promise<Array<HaNodeStatus | null>> {
  return Promise.all(NODES.map(node => readOne(dir, node)));
}

function fresh(status: HaNodeStatus, now: number): boolean {
  return typeof status.updatedAtUnix === "number" &&
    Number.isFinite(status.updatedAtUnix) &&
    now - status.updatedAtUnix * 1000 <= HEALTH_THRESHOLDS.haStatusMaxAgeSeconds * 1000;
}

function nodeList(items: HaNodeStatus[]): string {
  return items.map(item => item.node).join(", ");
}

/**
 * Три проверки, которых нет у диск/память/backup:
 *
 * - `replication` — primary сообщил streaming-реплику и её лаг;
 * - `standby` — есть свежий снимок standby, а не только primary;
 * - `controller` — ни один контроллер не завис и не упал в `failed`.
 *
 * Свежесть обязательна: старый файл на выключенной ноде выглядел бы как живая пара.
 */
export async function collectHaChecks(now = Date.now(), dir = dataDir()): Promise<HealthCheck[]> {
  const statuses = (await readHaStatuses(dir)).filter((item): item is HaNodeStatus => Boolean(item));
  if (!statuses.length) return [];

  const freshStatuses = statuses.filter(item => fresh(item, now));
  const staleStatuses = statuses.filter(item => !fresh(item, now));
  const missingStatuses = NODES.filter(node => !statuses.some(item => item.node === node));
  const primary = freshStatuses.find(item => item.role === "primary");
  const standbys = freshStatuses.filter(item => item.role === "standby");

  const checks: HealthCheck[] = [];

  if (!primary) {
    checks.push({
      id: "replication",
      label: "Репликация",
      ok: false,
      value: null,
      limit: HEALTH_THRESHOLDS.replicationLagBytes,
      unit: "bytes",
      detail: staleStatuses.length
        ? "нет свежего статуса primary: " + nodeList(staleStatuses)
        : "primary не сообщил статус",
    });
  } else if (primary.replicationStreams === null || primary.replicationStreams === undefined) {
    checks.push({
      id: "replication",
      label: "Репликация",
      ok: null,
      value: null,
      limit: HEALTH_THRESHOLDS.replicationLagBytes,
      unit: "bytes",
      detail: "primary не прочитал pg_stat_replication",
    });
  } else if (primary.replicationStreams < 1) {
    checks.push({
      id: "replication",
      label: "Репликация",
      ok: false,
      value: primary.replicationLagBytes ?? null,
      limit: HEALTH_THRESHOLDS.replicationLagBytes,
      unit: "bytes",
      detail: "нет streaming-реплик",
    });
  } else {
    const lag = primary.replicationLagBytes;
    checks.push({
      id: "replication",
      label: "Репликация",
      ok: lag === null || lag === undefined ? null : lag <= HEALTH_THRESHOLDS.replicationLagBytes,
      value: lag ?? null,
      limit: HEALTH_THRESHOLDS.replicationLagBytes,
      unit: "bytes",
      ...(lag === null || lag === undefined ? { detail: "лаг не измерен" } : {}),
    });
  }

  checks.push({
    id: "standby",
    label: "Резервная нода",
    ok: standbys.length > 0,
    value: standbys.length,
    limit: 1,
    unit: "count",
    ...(standbys.length
      ? {}
      : { detail: staleStatuses.length ? "нет свежего standby: " + nodeList(staleStatuses) : "standby не сообщил статус" }),
  });

  const failed = freshStatuses.filter(item => item.phase === "failed");
  const archiveBad = freshStatuses.filter(item => item.archiveReady === false);
  checks.push({
    id: "controller",
    label: "HA-контроллер",
    ok: failed.length === 0 && archiveBad.length === 0 && staleStatuses.length === 0 && missingStatuses.length === 0,
    value: failed.length + archiveBad.length + staleStatuses.length + missingStatuses.length,
    limit: 0,
    unit: "count",
    ...(!failed.length && !archiveBad.length && !staleStatuses.length && !missingStatuses.length
      ? {}
      : {
          detail: [
            failed.length ? "failed: " + nodeList(failed) : "",
            archiveBad.length ? "WAL-архив не готов: " + nodeList(archiveBad) : "",
            staleStatuses.length ? "нет свежего статуса: " + nodeList(staleStatuses) : "",
            missingStatuses.length ? "нет снимка: " + missingStatuses.join(", ") : "",
          ].filter(Boolean).join("; "),
        }),
  });

  return checks;
}
