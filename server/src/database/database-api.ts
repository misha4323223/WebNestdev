import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import {
  deleteDatabaseConnection,
  getDatabaseConnection,
  isDatabaseProvider,
  saveDatabaseConnection,
  type DatabaseConnection,
  type DatabaseProvider,
} from "./database-connection-store.js";

/** Schemes the agent can actually work with, each with the port the provider uses. */
const DEFAULT_PORTS: Record<string, number> = {
  postgres: 5432,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  "mongodb+srv": 27017,
  redis: 6379,
  rediss: 6379,
  ydb: 2135,
  grpcs: 2135,
  grpc: 2135,
};

const SCHEME_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  mongodb: "MongoDB",
  "mongodb+srv": "MongoDB Atlas",
  redis: "Redis",
  rediss: "Redis с TLS",
  ydb: "YDB",
  grpcs: "YDB",
  grpc: "YDB",
};

/** Metadata endpoints must never be reachable through the connection check. */
const BLOCKED_HOSTS = /^(169\.254\.|metadata\.google\.internal$|metadata\.yandex$)/i;

export type DatabaseParts = {
  scheme: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
};

export function databaseSchemeLabel(scheme: string) {
  return SCHEME_LABELS[scheme] ?? scheme;
}

/**
 * One connection string is the format every provider console shows, so it is the
 * primary input; the individual fields below only exist for providers that split them.
 */
export function parseDatabaseUrl(raw: string): DatabaseParts {
  const value = raw.trim();
  if (!value) throw new Error("Вставьте строку подключения базы данных");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new Error("Строка подключения должна начинаться со схемы, например postgresql://user:password@host:5432/database");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Не удалось разобрать строку подключения"); }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!(scheme in DEFAULT_PORTS)) {
    throw new Error("Поддерживаются PostgreSQL, MySQL/MariaDB, MongoDB, Redis и YDB — с другими базами агент не сможет помочь");
  }
  const host = url.hostname.trim();
  if (!host) throw new Error("В строке подключения нет хоста");
  if (BLOCKED_HOSTS.test(host)) throw new Error("Этот адрес недоступен из рабочей области");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("В строке подключения нет имени базы данных");
  const port = Number(url.port) || DEFAULT_PORTS[scheme];
  return {
    scheme,
    host,
    port,
    database,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: /(\?|&)(ssl(mode)?=(require|verify|true|1)|tls=true)/i.test(value) || scheme === "rediss" || scheme === "grpcs" || port === 6380,
  };
}

/** Assembles a connection string from separate fields, with the SSL flag kept explicit. */
export function buildDatabaseUrl(parts: DatabaseParts) {
  const scheme = parts.scheme.toLowerCase();
  if (!(scheme in DEFAULT_PORTS)) throw new Error("Укажите тип базы: PostgreSQL, MySQL, MongoDB, Redis или YDB");
  const auth = parts.username || parts.password
    ? encodeURIComponent(parts.username) + ":" + encodeURIComponent(parts.password) + "@"
    : "";
  const port = Number(parts.port) || DEFAULT_PORTS[scheme];
  const sslQuery = !parts.ssl ? ""
    : scheme === "postgres" || scheme === "postgresql" ? "?sslmode=require"
      : scheme === "mysql" || scheme === "mariadb" ? "?ssl=true"
        : scheme === "mongodb" || scheme === "mongodb+srv" ? "?tls=true"
          : "";
  return scheme + "://" + auth + parts.host + ":" + port + "/" + encodeURIComponent(parts.database) + sslQuery;
}

/** Never log or return the real password: the UI and the model only see this form. */
export function maskDatabaseUrl(connection: Pick<DatabaseConnection, "scheme" | "username" | "host" | "port" | "database">) {
  const auth = connection.username ? connection.username + ":***@" : "";
  return connection.scheme + "://" + auth + connection.host + ":" + connection.port + "/" + connection.database;
}

export type DatabaseStatus =
  | { connected: false }
  | {
      connected: true;
      id: string;
      provider: DatabaseProvider;
      scheme: string;
      engine: string;
      host: string;
      port: number;
      database: string;
      username: string;
      ssl: boolean;
      maskedUrl: string;
      createdAt: string;
      updatedAt: string;
    };

export async function databaseStatus(userId: string): Promise<DatabaseStatus> {
  const connection = await getDatabaseConnection(userId);
  if (!connection) return { connected: false };
  return {
    connected: true,
    id: connection.id,
    provider: connection.provider,
    scheme: connection.scheme,
    engine: databaseSchemeLabel(connection.scheme),
    host: connection.host,
    port: connection.port,
    database: connection.database,
    username: connection.username,
    ssl: connection.ssl,
    maskedUrl: maskDatabaseUrl(connection),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export type DatabaseCredentialInput = {
  provider?: string;
  url?: string;
  scheme?: string;
  host?: string;
  port?: number | string;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
};

/**
 * Accepts either the provider's connection string or the separate fields, and stores
 * the result encrypted. The connection is not verified here: a TCP probe from the API
 * host says nothing about a database behind the provider's private network, so the
 * card and the agent both get an honest "saved, run a check when you need it".
 */
export async function saveDatabaseCredential(userId: string, input: DatabaseCredentialInput) {
  const provider = isDatabaseProvider(input.provider) ? input.provider : "custom";
  const parts = input.url?.trim()
    ? parseDatabaseUrl(input.url)
    : parseDatabaseFields(input);
  const existing = await getDatabaseConnection(userId);
  const now = new Date().toISOString();
  const connection: DatabaseConnection = {
    userId,
    id: existing?.id ?? randomUUID(),
    provider,
    ...parts,
    url: input.url?.trim() || buildDatabaseUrl(parts),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await saveDatabaseConnection(connection);
  return databaseStatus(userId);
}

function parseDatabaseFields(input: DatabaseCredentialInput): DatabaseParts {
  const scheme = (input.scheme ?? "postgres").trim().toLowerCase();
  if (!(scheme in DEFAULT_PORTS)) throw new Error("Укажите тип базы: PostgreSQL, MySQL, MongoDB, Redis или YDB");
  const host = input.host?.trim() ?? "";
  const database = input.database?.trim() ?? "";
  const username = input.username?.trim() ?? "";
  if (!host) throw new Error("Укажите хост базы данных");
  if (!database) throw new Error("Укажите имя базы данных");
  const port = Number(input.port) || DEFAULT_PORTS[scheme];
  return {
    scheme,
    host,
    port,
    database,
    username,
    password: input.password ?? "",
    ssl: Boolean(input.ssl),
  };
}

/** Rebuilds the connection string the project should use; only server code calls this. */
export async function getDatabaseUrl(userId: string) {
  const connection = await getDatabaseConnection(userId);
  if (!connection) return null;
  return connection.url || buildDatabaseUrl(connection);
}

export async function disconnectDatabase(userId: string) {
  await deleteDatabaseConnection(userId);
  return databaseStatus(userId);
}

/**
 * Node reports a refused connection as an AggregateError with an empty message when the
 * host resolves to several addresses, so the errno code — not the message — is what the
 * user actually needs to read.
 */
function describeSocketError(code: string | undefined, message: string) {
  if (code === "ECONNREFUSED") return "порт закрыт: соединение отклонено";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "хост не найден — проверьте адрес базы";
  if (code === "ETIMEDOUT") return "превышено время ожидания";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "сеть недоступна с сервера";
  if (code === "EACCES" || code === "EPERM") return "соединение запрещено";
  return message || code || "не удалось подключиться";
}

/**
 * A plain TCP probe. It proves the address is reachable from the API host — nothing
 * more — which is why the answer is reported as reachability, never as "credentials OK".
 */
export async function checkDatabaseReachable(connection: { host: string; port: number }, timeoutMs = 6000) {
  if (BLOCKED_HOSTS.test(connection.host)) return { ok: false, error: "Этот адрес недоступен из рабочей области" };
  const started = Date.now();
  return await new Promise<{ ok: boolean; latencyMs?: number; error?: string }>(resolve => {
    const socket = createConnection({ host: connection.host, port: connection.port });
    let settled = false;
    const done = (result: { ok: boolean; latencyMs?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done({ ok: true, latencyMs: Date.now() - started }));
    socket.once("timeout", () => done({ ok: false, error: "База не ответила за " + Math.round(timeoutMs / 1000) + " с" }));
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const message = error instanceof Error ? error.message : String(error ?? "");
      done({ ok: false, error: describeSocketError(code, message) });
    });
  });
}
