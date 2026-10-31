import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { runDockerSandbox } from "../docker-sandbox.js";
import { runDockerCli } from "../sandbox/docker/cli.js";
import { buildSandboxConfig, sandboxRootPath } from "../sandbox/config.js";
import type { DockerCommandResult } from "../sandbox/docker/types.js";
import { nodeId } from "../nodes/identity.js";
import {
  runnerCommandSchema,
  runnerDockerSchema,
  runnerRelaySchema,
  type RunnerErrorBody,
  type RunnerStatus,
} from "./protocol.js";
import { assertDockerArgsAllowed, assertExtraMountsAllowed, RunnerPolicyError } from "./policy.js";
import { runnerStatus } from "./status.js";
import { createPreviewRelayManager, type PreviewRelayManager } from "./preview-relay.js";

const DEFAULT_BODY_LIMIT = 50_000_000;

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function sendError(response: ServerResponse, error: unknown) {
  if (error instanceof RunnerPolicyError) {
    sendJson(response, error.statusCode, { error: error.message, code: "RUNNER_POLICY" } satisfies RunnerErrorBody);
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, { error: error.message } satisfies RunnerErrorBody);
    return;
  }
  if (error instanceof z.ZodError) {
    sendJson(response, 400, { error: "Некорректный запрос к runner", code: "RUNNER_BAD_REQUEST" } satisfies RunnerErrorBody);
    return;
  }
  sendJson(response, 500, { error: "Внутренняя ошибка runner" } satisfies RunnerErrorBody);
}

function tokenMatches(header: string | undefined, expected: string) {
  if (!expected) return false;
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function readJson(request: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let done = false;
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, "Слишком большое тело запроса"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (done) return;
      done = true;
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Тело запроса не является JSON"));
      }
    });
    request.on("error", fail);
  });
}

function relativeCwd(root: string, cwd: string) {
  if (path.isAbsolute(cwd)) throw new HttpError(400, "cwd должен быть путём внутри проекта");
  const resolved = path.resolve(root, cwd || ".");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new HttpError(400, "cwd выходит за пределы каталога проекта");
  }
  return resolved;
}

/**
 * The API only needs Docker operations on containers it created: previews and long jobs. A
 * bearer token must not turn into `exec` into the database or the platform API container by
 * guessing a container id. Ownership is checked from the container's labels, not from its name:
 * ids are opaque and names can be reused.
 */
function dockerTargets(args: string[]): { ids: string[]; allowMissing: boolean } {
  if (args[0] === "rm") return { ids: args.slice(2), allowMissing: true };
  if (args[0] === "logs" || args[0] === "inspect") return { ids: [args[3]], allowMissing: true };
  if (args[0] === "exec") {
    return { ids: [args[1] === "-d" ? args[2] : args[1]], allowMissing: false };
  }
  if (args[0] === "network" && args[1] === "connect") {
    return { ids: [args[3]], allowMissing: false };
  }
  return { ids: [], allowMissing: true };
}

async function assertOwnedContainers(
  docker: (args: string[], timeoutMs?: number) => ReturnType<typeof runDockerCli>,
  args: string[],
) {
  const target = dockerTargets(args);
  for (const id of target.ids) {
    if (!id) continue;
    const inspected = await docker([
      "inspect",
      "-f",
      '{{index .Config.Labels "webnestdev.preview"}}|{{index .Config.Labels "webnestdev.job"}}',
      id,
    ], 5_000).catch(() => null);
    if (!inspected) throw new HttpError(503, "Runner не смог проверить контейнер");
    if (inspected.code !== 0) {
      if (target.allowMissing) continue;
      throw new HttpError(403, "Контейнер не принадлежит платформе");
    }
    const [preview = "", job = ""] = inspected.stdout.trim().split("|");
    const hasLabel = (value: string) => Boolean(value) && value !== "<no value>" && value !== "null";
    if (!hasLabel(preview) && !hasLabel(job)) throw new HttpError(403, "Контейнер не принадлежит платформе");
  }
}

export type RunnerDeps = {
  token: string;
  /** Overridden by tests; production uses the local Docker CLI. */
  runCommand?: (config: ReturnType<typeof buildSandboxConfig>, command: string, cwd: string, options: Parameters<typeof runDockerSandbox>[3]) => Promise<DockerCommandResult>;
  docker?: (args: string[], timeoutMs?: number) => ReturnType<typeof runDockerCli>;
  status?: () => Promise<RunnerStatus>;
  relay?: PreviewRelayManager;
};

/**
 * HTTP server for one runner. It has no cookies, no CORS, no storage and no platform secrets:
 * a single bearer token and a JSON body. Binding is controlled by the caller (`RUNNER_BIND`);
 * the default in `main.ts` is loopback so a misconfigured runner is not exposed by accident.
 */
export function createRunnerServer(deps: RunnerDeps) {
  const run = deps.runCommand ?? runDockerSandbox;
  const docker = deps.docker ?? runDockerCli;
  const status = deps.status ?? runnerStatus;
  const relay = deps.relay ?? createPreviewRelayManager({ docker });

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://runner.local");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, nodeId: nodeId() });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Метод не поддерживается" } satisfies RunnerErrorBody);
        return;
      }
      if (!tokenMatches(request.headers.authorization, deps.token)) {
        sendJson(response, 401, { error: "Неверный токен runner" } satisfies RunnerErrorBody);
        return;
      }

      if (url.pathname === "/v1/status") {
        // Drain the body even though status has none: an unread request body keeps the
        // connection from being reused and confuses keep-alive clients.
        await readJson(request, 1_000).catch(() => undefined);
        sendJson(response, 200, await status());
        return;
      }

      if (url.pathname === "/v1/command") {
        const body = runnerCommandSchema.parse(await readJson(request));
        const root = sandboxRootPath(body.projectId);
        const cwd = relativeCwd(root, body.cwd);
        await assertExtraMountsAllowed(body.options?.extraMounts);
        const config = buildSandboxConfig(body.projectId, root, nodeId());
        if (body.options?.timeoutMs) config.timeoutMs = body.options.timeoutMs;
        const controller = new AbortController();
        const onClose = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once("close", onClose);
        try {
          const result = await run(config, body.command, cwd, {
            network: body.options?.network,
            env: body.options?.env,
            timeoutMs: body.options?.timeoutMs,
            maskSecretEnvFiles: body.options?.maskSecretEnvFiles,
            signal: controller.signal,
            extraMounts: body.options?.extraMounts,
          });
          sendJson(response, 200, result);
        } finally {
          response.removeListener("close", onClose);
        }
        return;
      }

      if (url.pathname === "/v1/docker") {
        const body = runnerDockerSchema.parse(await readJson(request));
        await assertDockerArgsAllowed(body.args);
        await assertOwnedContainers(docker, body.args);
        const result = await docker(body.args, body.timeoutMs);
        // The API removes a preview with `docker rm -f`; the relay belongs to that container
        // and must not outlive it. Doing this here covers every removal path (stop, failed
        // start, status cleanup) without teaching the API about relay lifecycles.
        if (body.args[0] === "rm" && body.args[1] === "-f") {
          await Promise.all(body.args.slice(2).map(id => relay.close(id)));
        }
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/v1/preview/relay") {
        const body = runnerRelaySchema.parse(await readJson(request, 8_000));
        await assertOwnedContainers(docker, ["inspect", "-f", "{{.State.Running}}", body.containerId]);
        sendJson(response, 200, await relay.open(body.containerId, body.targetPort));
        return;
      }

      sendJson(response, 404, { error: "Неизвестный маршрут runner" } satisfies RunnerErrorBody);
    } catch (error) {
      sendError(response, error);
    }
  });
}
