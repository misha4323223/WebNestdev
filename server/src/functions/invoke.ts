import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerCli } from "../sandbox/docker/cli.js";
import { sandboxImage, sandboxRuntimeArgs } from "../sandbox/config.js";
import { hostingSitesDir } from "../hosting/config.js";
import type { BuiltFunction } from "./build.js";
import { functionsNetwork } from "./network.js";

export type BackgroundJobRequest = {
  name: string;
  payload: unknown;
  idempotencyKey?: string;
};

export const BACKGROUND_JOB_MAX_PER_RESPONSE = 10;
export const BACKGROUND_JOB_MAX_PAYLOAD_BYTES = 64 * 1024;

/** Задание, которое HTTP-функция просит поставить в очередь после ответа. */
export function normalizeBackgroundJobRequests(raw: unknown): BackgroundJobRequest[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > BACKGROUND_JOB_MAX_PER_RESPONSE) {
    throw new FunctionInvokeError("В одном ответе больше " + BACKGROUND_JOB_MAX_PER_RESPONSE + " заданий", 413);
  }
  const out: BackgroundJobRequest[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new FunctionInvokeError("Задание должно быть объектом", 502);
    const value = item as { name?: unknown; payload?: unknown; idempotencyKey?: unknown };
    if (typeof value.name !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(value.name)) {
      throw new FunctionInvokeError("Некорректное имя фонового задания", 502);
    }
    if (value.idempotencyKey !== undefined && (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length === 0 || value.idempotencyKey.length > 200)) {
      throw new FunctionInvokeError("idempotencyKey задания должен быть строкой до 200 символов", 502);
    }
    const payload = value.payload === undefined ? {} : value.payload;
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new FunctionInvokeError("payload задания не сериализуется", 502);
    if (Buffer.byteLength(encoded, "utf8") > BACKGROUND_JOB_MAX_PAYLOAD_BYTES) {
      throw new FunctionInvokeError("payload задания больше 64 КиБ", 413);
    }
    out.push({
      name: value.name,
      payload,
      ...(typeof value.idempotencyKey === "string" ? { idempotencyKey: value.idempotencyKey } : {}),
    });
  }
  return out;
}

/**
 * Один HTTP-вызов функции в одноразовом контейнере.
 *
 * Контейнер не закреплён за сайтом: он создаётся на запрос, получает read-only артефакт,
 * живёт до ответа и удаляется. Это и есть serverless-модель без постоянного контейнера на
 * проект. Сеть — отдельная `FUNCTIONS_DOCKER_NETWORK`, подключённая только к интернету:
 * функция видит внешние API, но не сеть платформы, не PostgreSQL и не чужие preview. Хост
 * дополнительно отклоняет private/link-local/metadata (`egress-firewall.sh`).
 */

export type FunctionRequest = {
  method: string;
  path: string;
  /** Разобранные query-параметры: `{ limit: "2" }`, а не строка `?limit=2`. */
  query: Record<string, string>;
  /** Исходная query-строка — для функций, которым нужен точный запрос как есть. */
  search: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

export type FunctionResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** Задания, которые нужно поставить в очередь до отправки ответа клиенту. */
  jobs?: BackgroundJobRequest[];
};

/** Общая часть HTTP-функции и фонового задания для исполнителя. */
export type InvokableFunction = Pick<BuiltFunction, "handler" | "timeoutMs" | "memoryMb"> & { name: string };

export class FunctionInvokeError extends Error {
  readonly code = "FUNCTION_INVOKE_FAILED";

  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = "FunctionInvokeError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_ENV_BYTES = 100 * 1024;

function sitesHostRoot() {
  return path.resolve(
    process.env.HOSTING_SITES_HOST_DIR?.trim() ||
      process.env.WEBNESTDEV_SITES_HOST_DIR?.trim() ||
      process.env.WEBNESTDEV_SITES_DIR?.trim() ||
      hostingSitesDir(),
  );
}

/** Путь внутри API (`/srv/sites/…`) → путь, который видит Docker на хосте. */
export function dockerHostPathForSiteArtifact(artifactDir: string) {
  const apiRoot = path.resolve(hostingSitesDir());
  const hostRoot = sitesHostRoot();
  const relative = path.relative(apiRoot, path.resolve(artifactDir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new FunctionInvokeError("Артефакт функции находится вне каталога сайтов", 500);
  }
  return path.join(hostRoot, relative);
}

async function workerSource() {
  const url = new URL("./worker.mjs", import.meta.url);
  return readFile(fileURLToPath(url), "utf8");
}

function safeEnv(input: Record<string, string> | undefined) {
  const output: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) continue;
    if (/^(PATH|HOME|NODE_OPTIONS|WEBNESTDEV_)/.test(key)) continue;
    if (typeof value !== "string") continue;
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
    if (bytes > MAX_ENV_BYTES) throw new FunctionInvokeError("Слишком много переменных окружения для функции", 413);
    output[key] = value;
  }
  return output;
}

function normalizeHeaders(input: Record<string, string>) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key || /[\r\n]/.test(key) || /[\r\n]/.test(value)) continue;
    if (/^(connection|transfer-encoding|content-length|keep-alive)$/i.test(key)) continue;
    output[key] = value;
  }
  return output;
}

export async function invokeFunction(input: {
  artifactDir: string;
  fn: InvokableFunction;
  request: FunctionRequest;
  env?: Record<string, string>;
  /** HTTP-функции ограничены 30 секундами, фоновые задания — 60. */
  maxTimeoutMs?: number;
  /** Точка подмены для тестов: по умолчанию настоящий Docker CLI. */
  run?: typeof runDockerCli;
}): Promise<FunctionResponse> {
  const run = input.run ?? runDockerCli;
  if (Buffer.byteLength(input.request.bodyBase64, "base64") > MAX_REQUEST_BYTES) {
    throw new FunctionInvokeError("Тело запроса больше 1 МиБ", 413);
  }
  const timeoutLimit = Math.min(60_000, Math.max(100, input.maxTimeoutMs ?? 30_000));
  const timeoutMs = Math.min(timeoutLimit, Math.max(100, input.fn.timeoutMs || DEFAULT_TIMEOUT_MS));
  const memoryMb = Math.min(1_024, Math.max(128, input.fn.memoryMb || 256));
  const name = "wnd-fn-" + randomUUID().replaceAll("-", "").slice(0, 20);
  const worker = await workerSource();
  const hostArtifact = dockerHostPathForSiteArtifact(input.artifactDir);
  const env = safeEnv(input.env);
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", key + "=" + value]);

  const args = [
    "run", "-i", "--rm", "--init",
    ...sandboxRuntimeArgs(),
    "--network", functionsNetwork(),
    "--cpus", "0.5",
    "--memory", String(memoryMb) + "m",
    "--pids-limit", "64",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,size=64m",
    "--user", "1000:1000",
    "--name", name,
    "--label", "webnestdev.function=1",
    "-v", hostArtifact + ":/workspace:ro",
    "-w", "/workspace",
    ...envArgs,
    "-e", "HOME=/tmp",
    "-e", "NODE_ENV=production",
    "-e", "WEBNESTDEV_FUNCTION_MODULE=/workspace/index.mjs",
    "-e", "WEBNESTDEV_FUNCTION_EXPORT=" + input.fn.handler.split("#")[1],
    sandboxImage(),
    "node",
    "--permission",
    "--allow-fs-read=/workspace/index.mjs",
    "-e",
    worker,
  ];

  let result: Awaited<ReturnType<typeof runDockerCli>>;
  try {
    result = await run(args, timeoutMs + 5_000, JSON.stringify({ ...input.request, body: undefined }));
  } catch (error) {
    await run(["rm", "-f", name], 10_000).catch(() => undefined);
    throw new FunctionInvokeError(error instanceof Error ? error.message : String(error), 504);
  }
  if (result.code !== 0 && !result.stdout.trim()) {
    const reason = result.stderr.trim().slice(0, 2_000) || "контейнер функции завершился без ответа";
    throw new FunctionInvokeError(reason, 502);
  }

  let parsed: {
    ok?: boolean;
    status?: number;
    headers?: Record<string, string>;
    body?: string;
    error?: string;
    jobs?: unknown;
  };
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
  } catch {
    throw new FunctionInvokeError("Функция вернула не JSON: " + result.stdout.slice(0, 500), 502);
  }
  if (!parsed.ok) throw new FunctionInvokeError(String(parsed.error || "Функция завершилась с ошибкой"), 502);
  const status = Number.isInteger(parsed.status) && parsed.status! >= 100 && parsed.status! <= 599 ? parsed.status! : 200;
  const body = Buffer.from(parsed.body || "", "base64");
  if (body.byteLength > 2 * 1024 * 1024) throw new FunctionInvokeError("Ответ функции больше 2 МиБ", 502);
  const jobs = parsed.jobs === undefined ? undefined : normalizeBackgroundJobRequests(parsed.jobs);
  return { status, headers: normalizeHeaders(parsed.headers ?? {}), body, ...(jobs?.length ? { jobs } : {}) };
}
