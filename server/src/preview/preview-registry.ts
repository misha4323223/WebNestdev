import { getTable, initializeStorage, isYdbEnabled, ydbQuery } from "../storage/pg.js";
import type { PreviewState } from "./types.js";

/**
 * Общий реестр container-preview.
 *
 * Локальная `Map` в `preview-store.ts` остаётся горячим кэшем: статус и прокси читают её на
 * каждый файл приложения, и поход в PostgreSQL там был бы лишним. Но каждая запись зеркалится
 * сюда, а промах кэша на второй реплике поднимает состояние из базы. Без этого API на другой
 * ВМ отвечал «предпросмотр не запущен» на живой контейнер.
 *
 * Static-preview тоже сохраняется: его слушатель — часть конкретного процесса, поэтому строка
 * несёт `owner_address` — приватную дверь этого процесса. Вторая реплика не ходит на
 * `127.0.0.1:<port>`, а проксирует запрос на дверь владельца (см. preview/peer-door.ts).
 */

export type SharedPreviewBackend = {
  enabled: () => boolean;
  save: (state: PreviewState) => Promise<void>;
  remove: (projectId: string) => Promise<void>;
  touch: (projectId: string, lastUsedAt: number) => Promise<void>;
  get: (projectId: string, now: number) => Promise<PreviewState | null>;
  list: (now: number) => Promise<PreviewState[]>;
  prune: (now: number) => Promise<void>;
};

export function previewRegistryTtlMs(): number {
  const raw = process.env.PREVIEW_REGISTRY_TTL_MS?.trim();
  if (!raw) return 15 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 30_000 ? Math.floor(parsed) : 15 * 60_000;
}

type PreviewRow = {
  project_id: string;
  owner_user_id: string | null;
  node: string | null;
  mode: string;
  container_id: string | null;
  host: string | null;
  port: number | string | null;
  container_port: number | string | null;
  backend_host?: string | null;
  backend_port?: number | string | null;
  started_at: number | string;
  last_used_at: number | string;
  settled: boolean | null;
  exec_only: boolean | null;
  exec_only_checked_at: number | string | null;
  ready: boolean | null;
  checked_at: number | string | null;
  owner_address: string | null;
  expires_at: number | string;
};

function integer(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function optionalInteger(value: number | string | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : integer(value);
}

/** Строка БД → состояние; просроченная или неполная строка не считается живым preview. */
export function previewFromRow(row: PreviewRow, now = Date.now()): PreviewState | null {
  if ((row.mode !== "container" && row.mode !== "static" && row.mode !== "hybrid") || !row.project_id) return null;
  if (integer(row.expires_at) <= now) return null;
  const backendHost = row.backend_host?.trim() ?? "";
  const backendPort = optionalInteger(row.backend_port);
  // A hybrid row without both backend fields cannot be served: the listener has nowhere to
  // proxy, and pretending it is alive would produce a permanent 502 in the panel.
  if (row.mode === "hybrid" && (!backendHost || !backendPort)) return null;
  const state: PreviewState = {
    mode: row.mode,
    projectId: row.project_id,
    containerId: row.container_id ?? "",
    host: row.host ?? "",
    port: integer(row.port),
    startedAt: integer(row.started_at),
    lastUsedAt: integer(row.last_used_at),
    settled: Boolean(row.settled),
  };
  const owner = row.owner_user_id?.trim();
  if (owner) state.ownerUserId = owner;
  const ownerAddress = row.owner_address?.trim();
  if (ownerAddress) state.ownerAddress = ownerAddress;
  const node = row.node?.trim();
  if (node) state.node = node;
  const containerPort = optionalInteger(row.container_port);
  if (containerPort !== undefined) state.containerPort = containerPort;
  if (backendHost) state.backendHost = backendHost;
  if (backendPort !== undefined) state.backendPort = backendPort;
  if (row.exec_only) state.execOnly = true;
  const execCheckedAt = optionalInteger(row.exec_only_checked_at);
  if (execCheckedAt !== undefined) state.execOnlyCheckedAt = execCheckedAt;
  if (row.ready !== null) state.ready = Boolean(row.ready);
  const checkedAt = optionalInteger(row.checked_at);
  if (checkedAt !== undefined) state.checkedAt = checkedAt;
  return state;
}

const postgresBackend: SharedPreviewBackend = {
  enabled: () => isYdbEnabled(),
  async save(state) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("previews"));
    const now = Date.now();
    const expiresAt = now + previewRegistryTtlMs();
    await ydbQuery()`
      INSERT INTO ${table} (
        project_id, owner_user_id, node, mode, container_id, host, port, container_port,
        backend_host, backend_port,
        started_at, last_used_at, settled, exec_only, exec_only_checked_at, ready, checked_at,
        owner_address, updated_at, expires_at
      ) VALUES (
        ${state.projectId}, ${state.ownerUserId ?? ""}, ${state.node ?? ""}, ${state.mode},
        ${state.containerId}, ${state.host}, ${state.port}, ${state.containerPort ?? null},
        ${state.backendHost ?? ""}, ${state.backendPort ?? null},
        ${state.startedAt}, ${state.lastUsedAt}, ${Boolean(state.settled)}, ${Boolean(state.execOnly)},
        ${state.execOnlyCheckedAt ?? null}, ${state.ready ?? null}, ${state.checkedAt ?? null},
        ${state.ownerAddress ?? ""}, ${now}, ${expiresAt}
      )
      ON CONFLICT (project_id) DO UPDATE SET
        owner_user_id = COALESCE(NULLIF(EXCLUDED.owner_user_id, ''), ${table}.owner_user_id),
        node = EXCLUDED.node,
        mode = EXCLUDED.mode,
        container_id = EXCLUDED.container_id,
        host = EXCLUDED.host,
        port = EXCLUDED.port,
        container_port = EXCLUDED.container_port,
        backend_host = EXCLUDED.backend_host,
        backend_port = EXCLUDED.backend_port,
        started_at = EXCLUDED.started_at,
        last_used_at = EXCLUDED.last_used_at,
        settled = EXCLUDED.settled,
        exec_only = EXCLUDED.exec_only,
        exec_only_checked_at = EXCLUDED.exec_only_checked_at,
        ready = EXCLUDED.ready,
        checked_at = EXCLUDED.checked_at,
        owner_address = COALESCE(NULLIF(EXCLUDED.owner_address, ''), ${table}.owner_address),
        updated_at = EXCLUDED.updated_at,
        expires_at = EXCLUDED.expires_at`;
  },
  async remove(projectId) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("previews"));
    await ydbQuery()`DELETE FROM ${table} WHERE project_id = ${projectId}`;
  },
  async touch(projectId, lastUsedAt) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("previews"));
    const now = Date.now();
    await ydbQuery()`
      UPDATE ${table}
         SET last_used_at = GREATEST(last_used_at, ${lastUsedAt}),
             expires_at = ${now + previewRegistryTtlMs()},
             updated_at = ${now}
       WHERE project_id = ${projectId}`;
  },
  async get(projectId, now) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("previews"));
    const [rows] = await ydbQuery()<PreviewRow[]>`
      SELECT * FROM ${table}
       WHERE project_id = ${projectId} AND expires_at > ${now}
       LIMIT 1`;
    return rows[0] ? previewFromRow(rows[0], now) : null;
  },
  async list(now) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("previews"));
    const [rows] = await ydbQuery()<PreviewRow[]>`
      SELECT * FROM ${table}
       WHERE expires_at > ${now}
       ORDER BY last_used_at DESC`;
    return rows.map(row => previewFromRow(row, now)).filter((state): state is PreviewState => state !== null);
  },
  async prune(now) {
    await initializeStorage();
    const table = ydbQuery().identifier(getTable("previews"));
    await ydbQuery()`DELETE FROM ${table} WHERE expires_at <= ${now}`;
  },
};

let backend: SharedPreviewBackend = postgresBackend;

/** Подмена для unit-тестов: настоящий PostgreSQL в них не поднимается. */
export function setPreviewRegistryBackendForTests(next: SharedPreviewBackend | null): void {
  backend = next ?? postgresBackend;
}

export function sharedPreviewRegistryEnabled(): boolean {
  return backend.enabled();
}

export function saveSharedPreview(state: PreviewState): Promise<void> {
  if (!backend.enabled()) return Promise.resolve();
  return backend.save(state);
}

export function removeSharedPreview(projectId: string): Promise<void> {
  if (!backend.enabled()) return Promise.resolve();
  return backend.remove(projectId);
}

export function touchSharedPreview(projectId: string, lastUsedAt: number): Promise<void> {
  if (!backend.enabled()) return Promise.resolve();
  return backend.touch(projectId, lastUsedAt);
}

export function getSharedPreview(projectId: string): Promise<PreviewState | null> {
  if (!backend.enabled()) return Promise.resolve(null);
  return backend.get(projectId, Date.now());
}

export function listSharedPreviews(): Promise<PreviewState[]> {
  if (!backend.enabled()) return Promise.resolve([]);
  return backend.list(Date.now());
}

export function pruneSharedPreviews(): Promise<void> {
  if (!backend.enabled()) return Promise.resolve();
  return backend.prune(Date.now());
}
