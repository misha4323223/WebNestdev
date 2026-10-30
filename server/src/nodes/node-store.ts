import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/pg.js";
import { nodeId } from "./identity.js";

/**
 * Persistent node registry.
 *
 * The registry must survive a server restart and be visible to every API replica. Keeping it in
 * the same PostgreSQL as projects means a second replica does not invent its own pool, and a
 * project's `node` pin points at a row that exists. JSON is only the local development/test
 * backend; production already runs PostgreSQL.
 */
export type SandboxNodeStatus = "online" | "draining" | "offline";

export type SandboxNode = {
  id: string;
  /** Empty for the local node; a remote runner will publish its private address here. */
  address: string;
  status: SandboxNodeStatus;
  memoryTotalMb: number;
  memoryUsedMb: number;
  containers: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type NodeMetricsUpdate = Pick<
  SandboxNode,
  "id" | "address" | "memoryTotalMb" | "memoryUsedMb" | "containers" | "lastSeenAt" | "updatedAt"
>;

type NodeRow = {
  id: string;
  address: string | null;
  status: string;
  memory_total_mb: number | string | null;
  memory_used_mb: number | string | null;
  containers: number | string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

const STATUSES = new Set<SandboxNodeStatus>(["online", "draining", "offline"]);

function dataDir() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

export function nodeStateFile() {
  return path.join(dataDir(), "nodes", "state.json");
}

function integer(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function status(value: unknown): SandboxNodeStatus {
  return typeof value === "string" && STATUSES.has(value as SandboxNodeStatus)
    ? (value as SandboxNodeStatus)
    : "offline";
}

function parseNode(raw: unknown): SandboxNode | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const lastSeenAt = typeof value.lastSeenAt === "string" ? value.lastSeenAt.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt.trim() : "";
  if (!id || !lastSeenAt || !createdAt || !updatedAt) return null;
  return {
    id,
    address: typeof value.address === "string" ? value.address.trim() : "",
    status: status(value.status),
    memoryTotalMb: integer(value.memoryTotalMb),
    memoryUsedMb: integer(value.memoryUsedMb),
    containers: integer(value.containers),
    lastSeenAt,
    createdAt,
    updatedAt,
  };
}

function rowToNode(row: NodeRow): SandboxNode {
  return {
    id: row.id,
    address: row.address ?? "",
    status: status(row.status),
    memoryTotalMb: integer(row.memory_total_mb),
    memoryUsedMb: integer(row.memory_used_mb),
    containers: integer(row.containers),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Serialize file mutations: a heartbeat and a project placement can arrive together. */
let fileQueue: Promise<unknown> = Promise.resolve();
function withFileLock<T>(task: () => Promise<T>): Promise<T> {
  const result = fileQueue.then(task, task);
  fileQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function readFileNodes(): Promise<SandboxNode[]> {
  try {
    const parsed = JSON.parse(await readFile(nodeStateFile(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseNode).filter((node): node is SandboxNode => node !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeFileNodes(nodes: SandboxNode[]) {
  const file = nodeStateFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(nodes, null, 2), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function listNodes(): Promise<SandboxNode[]> {
  if (!isYdbEnabled()) {
    return (await readFileNodes()).sort((left, right) => left.id.localeCompare(right.id));
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("nodes"));
  const [rows] = await ydbQuery()<NodeRow[]>`
    SELECT id, address, status, memory_total_mb, memory_used_mb, containers,
           last_seen_at, created_at, updated_at
      FROM ${table}
     ORDER BY id`;
  return rows.map(rowToNode);
}

export async function getNode(id: string): Promise<SandboxNode | null> {
  if (!isYdbEnabled()) {
    return (await readFileNodes()).find(node => node.id === id) ?? null;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("nodes"));
  const [rows] = await ydbQuery()<NodeRow[]>`
    SELECT id, address, status, memory_total_mb, memory_used_mb, containers,
           last_seen_at, created_at, updated_at
      FROM ${table}
     WHERE id = ${id}
     LIMIT 1`;
  return rows[0] ? rowToNode(rows[0]) : null;
}

/**
 * Register a node or refresh its metrics. Status is owned by the operator, not by the
 * heartbeat: a draining node that sends a heartbeat must stay draining.
 */
export async function upsertNode(node: SandboxNode): Promise<SandboxNode> {
  const normalized: SandboxNode = {
    ...node,
    address: node.address.trim(),
    status: node.status,
    memoryTotalMb: integer(node.memoryTotalMb),
    memoryUsedMb: integer(node.memoryUsedMb),
    containers: integer(node.containers),
  };
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const nodes = await readFileNodes();
      const index = nodes.findIndex(item => item.id === normalized.id);
      if (index >= 0) nodes[index] = normalized;
      else nodes.push(normalized);
      await writeFileNodes(nodes.sort((left, right) => left.id.localeCompare(right.id)));
      return normalized;
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("nodes"));
  await ydbQuery()`
    INSERT INTO ${table} (
      id, address, status, memory_total_mb, memory_used_mb, containers,
      last_seen_at, created_at, updated_at
    ) VALUES (
      ${normalized.id}, ${normalized.address}, ${normalized.status},
      ${normalized.memoryTotalMb}, ${normalized.memoryUsedMb}, ${normalized.containers},
      ${normalized.lastSeenAt}, ${normalized.createdAt}, ${normalized.updatedAt}
    )
    ON CONFLICT (id) DO UPDATE SET
      address = EXCLUDED.address,
      status = EXCLUDED.status,
      memory_total_mb = EXCLUDED.memory_total_mb,
      memory_used_mb = EXCLUDED.memory_used_mb,
      containers = EXCLUDED.containers,
      last_seen_at = EXCLUDED.last_seen_at,
      updated_at = EXCLUDED.updated_at`;
  return normalized;
}

/**
 * Refresh observed fields without touching `status`. A heartbeat must never overwrite a drain
 * that an administrator performed between the read and the write.
 */
export async function updateNodeMetrics(update: NodeMetricsUpdate): Promise<SandboxNode | null> {
  const normalized: NodeMetricsUpdate = {
    id: update.id,
    address: update.address.trim(),
    memoryTotalMb: integer(update.memoryTotalMb),
    memoryUsedMb: integer(update.memoryUsedMb),
    containers: integer(update.containers),
    lastSeenAt: update.lastSeenAt,
    updatedAt: update.updatedAt,
  };
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const nodes = await readFileNodes();
      const index = nodes.findIndex(node => node.id === normalized.id);
      if (index < 0) return null;
      const updated = { ...nodes[index], ...normalized };
      nodes[index] = updated;
      await writeFileNodes(nodes);
      return updated;
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("nodes"));
  const [rows] = await ydbQuery()<NodeRow[]>`
    UPDATE ${table}
       SET address = ${normalized.address},
           memory_total_mb = ${normalized.memoryTotalMb},
           memory_used_mb = ${normalized.memoryUsedMb},
           containers = ${normalized.containers},
           last_seen_at = ${normalized.lastSeenAt},
           updated_at = ${normalized.updatedAt}
     WHERE id = ${normalized.id}
     RETURNING id, address, status, memory_total_mb, memory_used_mb, containers,
               last_seen_at, created_at, updated_at`;
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function setNodeStatus(id: string, next: SandboxNodeStatus): Promise<SandboxNode | null> {
  if (!isYdbEnabled()) {
    return withFileLock(async () => {
      const nodes = await readFileNodes();
      const index = nodes.findIndex(node => node.id === id);
      if (index < 0) return null;
      const updated = { ...nodes[index], status: next, updatedAt: new Date().toISOString() };
      nodes[index] = updated;
      await writeFileNodes(nodes);
      return updated;
    });
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("nodes"));
  const [rows] = await ydbQuery()<NodeRow[]>`
    UPDATE ${table}
       SET status = ${next}, updated_at = ${new Date().toISOString()}
     WHERE id = ${id}
     RETURNING id, address, status, memory_total_mb, memory_used_mb, containers,
               last_seen_at, created_at, updated_at`;
  return rows[0] ? rowToNode(rows[0]) : null;
}

/**
 * Projects per node. Existing rows from before the `node` column are still on the local
 * machine, so an empty value is counted as the local node rather than as an orphan.
 */
export async function countProjectsByNode(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (isYdbEnabled()) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("projects"));
    const [rows] = await ydbQuery()<Array<{ node: string | null; count: number | string }>>`
      SELECT node, COUNT(*)::int AS count
        FROM ${table}
       GROUP BY node`;
    for (const row of rows) counts.set((row.node ?? "").trim() || nodeId(), Number(row.count) || 0);
    return counts;
  }

  const projects = path.join(dataDir(), "projects");
  const names = await readdir(projects).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const project = JSON.parse(await readFile(path.join(projects, name), "utf8")) as { node?: unknown };
      const assigned = typeof project.node === "string" && project.node.trim() ? project.node.trim() : nodeId();
      counts.set(assigned, (counts.get(assigned) ?? 0) + 1);
    } catch {
      // A malformed project file is not a reason to hide all other nodes.
    }
  }
  return counts;
}

/**
 * One-time backfill for projects created before node pinning. A blank `node` means the project
 * lives on the node that is running this code. Returned count is logged at startup.
 */
export async function backfillProjectNodes(defaultNode: string): Promise<number> {
  if (!isYdbEnabled()) {
    const projectsDir = path.join(dataDir(), "projects");
    const names = await readdir(projectsDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    let changed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(projectsDir, name);
      try {
        const project = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        if (typeof project.node === "string" && project.node.trim()) continue;
        const temp = file + "." + randomUUID() + ".tmp";
        await writeFile(temp, JSON.stringify({ ...project, node: defaultNode }, null, 2), { mode: 0o600 });
        await rename(temp, file);
        changed++;
      } catch {
        // A malformed project is handled by the project store; the registry must not hide the
        // rest of the nodes because one old file is unreadable.
      }
    }
    return changed;
  }
  await initializeStorage();
  const table = ydbQuery().identifier(getTable("projects"));
  const [rows] = await ydbQuery()<Array<{ id: string }>>`
    UPDATE ${table}
       SET node = ${defaultNode}
     WHERE node = ''
     RETURNING id`;
  return rows.length;
}
