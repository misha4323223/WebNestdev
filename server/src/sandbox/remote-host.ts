import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import type { DockerCliResult, DockerCommandResult } from "./docker/types.js";
import type { SandboxHost, SandboxHostStatus, SandboxRunOptions } from "./host.js";

export class RemoteRunnerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
    readonly code = "RUNNER_UNAVAILABLE",
  ) {
    super(message);
    this.name = "RemoteRunnerError";
  }
}

function baseUrl(address: string) {
  const trimmed = address.trim().replace(/\/+$/, "");
  if (!trimmed) throw new RemoteRunnerError("Адрес runner пуст", 503, "RUNNER_CONFIG");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : "http://" + trimmed;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new RemoteRunnerError("Некорректный адрес runner: " + address, 503, "RUNNER_CONFIG");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RemoteRunnerError("Runner должен использовать http или https", 503, "RUNNER_CONFIG");
  }
  if (parsed.username || parsed.password) {
    throw new RemoteRunnerError("Адрес runner не должен содержать логин или пароль", 503, "RUNNER_CONFIG");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function abortError() {
  return Object.assign(new Error("Запрос к runner отменён"), { name: "AbortError" });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function commandResult(value: unknown): DockerCommandResult {
  const result = asRecord(value);
  if (typeof result.ok !== "boolean" || !(typeof result.exitCode === "number" || result.exitCode === null) ||
      typeof result.stdout !== "string" || typeof result.stderr !== "string" || typeof result.truncated !== "boolean") {
    throw new RemoteRunnerError("Runner вернул некорректный результат команды", 502, "RUNNER_BAD_RESPONSE");
  }
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    signal: typeof result.signal === "string" ? result.signal as NodeJS.Signals : null,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
  };
}

function dockerResult(value: unknown): DockerCliResult {
  const result = asRecord(value);
  if (typeof result.code !== "number" || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
    throw new RemoteRunnerError("Runner вернул некорректный результат Docker", 502, "RUNNER_BAD_RESPONSE");
  }
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

function statusResult(value: unknown, id: string): SandboxHostStatus {
  const result = asRecord(value);
  if (typeof result.ok !== "boolean" || typeof result.available !== "boolean") {
    throw new RemoteRunnerError("Runner вернул некорректный статус", 502, "RUNNER_BAD_RESPONSE");
  }
  if (typeof result.nodeId === "string" && result.nodeId !== id) {
    throw new RemoteRunnerError(
      "Runner по адресу узла " + id + " представился как " + result.nodeId + ": проверьте WEBNESTDEV_NODE_ADDRESS",
      502,
      "RUNNER_IDENTITY",
    );
  }
  const metrics = asRecord(result.metrics);
  const workspace = asRecord(result.workspace);
  return {
    mode: typeof result.mode === "string" ? result.mode : "docker",
    available: result.available,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(typeof result.detail === "string" ? { detail: result.detail } : {}),
    ...(typeof result.dockerVersion === "string" ? { dockerVersion: result.dockerVersion } : {}),
    ...(typeof result.nodeId === "string" ? { nodeId: result.nodeId } : {}),
    metrics: {
      memoryTotalMb: number(metrics.memoryTotalMb),
      memoryUsedMb: number(metrics.memoryUsedMb),
      containers: number(metrics.containers),
    },
    ...(typeof workspace.root === "string"
      ? {
          workspace: {
            root: workspace.root,
            hostRoot: typeof workspace.hostRoot === "string" ? workspace.hostRoot : workspace.root,
            shared: workspace.shared === true,
          },
        }
      : {}),
    ...(typeof result.previewNetwork === "string" ? { previewNetwork: result.previewNetwork } : {}),
    ...(Array.isArray(result.previewAttachNetworks)
      ? { previewAttachNetworks: result.previewAttachNetworks.filter((item): item is string => typeof item === "string") }
      : {}),
  };
}

export function createRemoteSandboxHost(input: { id: string; address: string; token: string }): SandboxHost {
  const url = baseUrl(input.address);
  const token = input.token.trim();
  if (token.length < 32) throw new RemoteRunnerError("Токен runner слишком короткий", 503, "RUNNER_CONFIG");

  async function requestJson(
    route: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url + route, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try { parsed = JSON.parse(text) } catch {
          throw new RemoteRunnerError("Runner вернул не JSON", 502, "RUNNER_BAD_RESPONSE");
        }
      }
      if (!response.ok) {
        const error = asRecord(parsed);
        const message = typeof error.error === "string" ? error.error : "Runner ответил " + response.status;
        const code = typeof error.code === "string" ? error.code : response.status === 401 ? "RUNNER_AUTH" : "RUNNER_ERROR";
        throw new RemoteRunnerError(message, response.status >= 500 ? 503 : response.status, code);
      }
      return parsed;
    } catch (error) {
      if (error instanceof RemoteRunnerError) throw error;
      if ((error as Error).name === "AbortError") {
        if (signal?.aborted) throw abortError();
        throw new RemoteRunnerError("Runner не ответил за " + Math.round(timeoutMs / 1000) + " с", 504, "RUNNER_TIMEOUT");
      }
      throw new RemoteRunnerError(
        "Runner недоступен: " + (error instanceof Error ? error.message : String(error)),
        503,
        "RUNNER_UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  let cached: { at: number; status: SandboxHostStatus } | null = null;

  async function status(timeoutMs = 10_000) {
    // Metrics are read by the heartbeat every 30 s and by placement occasionally; a five-second
    // cache keeps one preview status poll from calling the runner twice.
    if (cached && Date.now() - cached.at < 5_000) return cached.status;
    const value = statusResult(await requestJson("/v1/status", {}, timeoutMs), input.id);
    cached = { at: Date.now(), status: value };
    return value;
  }

  return {
    id: input.id,
    status: () => status(),
    async runCommand(config: SandboxConfig, command: string, cwd: string, options: SandboxRunOptions = {}) {
      const relative = path.relative(config.root, cwd);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new RemoteRunnerError("Команда выходит за каталог проекта", 400, "RUNNER_BAD_PATH");
      }
      const timeoutMs = Math.min(30 * 60_000, Math.max(10_000, (options.timeoutMs ?? config.timeoutMs) + 20_000));
      const value = await requestJson("/v1/command", {
        projectId: config.projectId,
        command,
        cwd: relative.split(path.sep).join("/"),
        options: {
          ...(options.network ? { network: options.network } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.maskSecretEnvFiles ? { maskSecretEnvFiles: true } : {}),
          ...(options.injectSecretEnvFile ? { injectSecretEnvFile: true } : {}),
          ...(options.extraMounts?.length ? { extraMounts: options.extraMounts } : {}),
        },
      }, timeoutMs, options.signal);
      return commandResult(value);
    },
    async docker(args: string[], timeoutMs = 15_000) {
      return dockerResult(await requestJson("/v1/docker", { args, timeoutMs }, timeoutMs + 5_000));
    },
    async networks() {
      const current = await status();
      return {
        preview: current.previewNetwork ?? "",
        attach: current.previewAttachNetworks ?? [],
      };
    },
    async previewRelay(containerId: string, targetPort: number) {
      const value = asRecord(await requestJson("/v1/preview/relay", { containerId, targetPort }, 10_000));
      if (typeof value.host !== "string" || !value.host.trim() ||
          typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65_535) {
        throw new RemoteRunnerError("Runner вернул некорректный адрес preview relay", 502, "RUNNER_BAD_RESPONSE");
      }
      return { host: value.host, port: value.port };
    },
  };
}
