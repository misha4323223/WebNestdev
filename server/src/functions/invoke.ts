import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerCli } from "../sandbox/docker/cli.js";
import { sandboxImage, sandboxRuntimeArgs } from "../sandbox/config.js";
import { hostingSitesDir } from "../hosting/config.js";
import type { BuiltFunction } from "./build.js";

/**
 * Один HTTP-вызов функции в одноразовом контейнере.
 *
 * Контейнер не закреплён за сайтом: он создаётся на запрос, получает read-only артефакт,
 * живёт до ответа и удаляется. Это и есть serverless-модель без постоянного контейнера на
 * проект. Сеть — bridge: функция видит интернет, но не сеть платформы и не PostgreSQL.
 */

export type FunctionRequest = {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

export type FunctionResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

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
  fn: BuiltFunction;
  request: FunctionRequest;
  env?: Record<string, string>;
  /** Точка подмены для тестов: по умолчанию настоящий Docker CLI. */
  run?: typeof runDockerCli;
}): Promise<FunctionResponse> {
  const run = input.run ?? runDockerCli;
  if (Buffer.byteLength(input.request.bodyBase64, "base64") > MAX_REQUEST_BYTES) {
    throw new FunctionInvokeError("Тело запроса больше 1 МиБ", 413);
  }
  const timeoutMs = Math.min(30_000, Math.max(100, input.fn.timeoutMs || DEFAULT_TIMEOUT_MS));
  const memoryMb = Math.min(1_024, Math.max(128, input.fn.memoryMb || 256));
  const name = "wnd-fn-" + randomUUID().replaceAll("-", "").slice(0, 20);
  const worker = await workerSource();
  const hostArtifact = dockerHostPathForSiteArtifact(input.artifactDir);
  const env = safeEnv(input.env);
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", key + "=" + value]);

  const args = [
    "run", "-i", "--rm", "--init",
    ...sandboxRuntimeArgs(),
    "--network", process.env.FUNCTIONS_DOCKER_NETWORK?.trim() || "bridge",
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

  let parsed: { ok?: boolean; status?: number; headers?: Record<string, string>; body?: string; error?: string };
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed;
  } catch {
    throw new FunctionInvokeError("Функция вернула не JSON: " + result.stdout.slice(0, 500), 502);
  }
  if (!parsed.ok) throw new FunctionInvokeError(String(parsed.error || "Функция завершилась с ошибкой"), 502);
  const status = Number.isInteger(parsed.status) && parsed.status! >= 100 && parsed.status! <= 599 ? parsed.status! : 200;
  const body = Buffer.from(parsed.body || "", "base64");
  if (body.byteLength > 2 * 1024 * 1024) throw new FunctionInvokeError("Ответ функции больше 2 МиБ", 502);
  return { status, headers: normalizeHeaders(parsed.headers ?? {}), body };
}
