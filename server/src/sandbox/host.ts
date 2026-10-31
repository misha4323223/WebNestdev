import type { SandboxConfig } from "../sandbox-manager.js";
import { getNode, updateNodeMetrics } from "../nodes/node-store.js";
import { isNodeFresh } from "../nodes/placement.js";
import type { DockerCliResult, DockerCommandResult } from "./docker/types.js";
import { localSandboxHost } from "./local-host.js";
import { createRemoteSandboxHost } from "./remote-host.js";

export type SandboxRunOptions = {
  network?: "none"|"bridge";
  /**
   * Переменные только для этого контейнера. Так токен интеграции попадает в процесс EAS,
   * не оказываясь ни в файле проекта, ни в команде оболочки.
   */
  env?: Record<string,string>;
  signal?: AbortSignal;
  /** Предел времени одной команды; по умолчанию `config.timeoutMs`. Ограничен сверху в docker-sandbox. */
  timeoutMs?: number;
  /**
   * Заменить секретные env-файлы пустыми read-only файлами внутри контейнера. Включается для
   * команд агента и сборки, но не для предпросмотра: приложению ключи нужны.
   */
  maskSecretEnvFiles?: boolean;
  /**
   * Смонтировать канонические секреты проекта как обычные env-файлы. Только для сборки и
   * предпросмотра: у команды агента противоположная задача — файл должен быть пустым.
   */
  injectSecretEnvFile?: boolean;
  /** Дополнительные `-v` аргументы; используется маскированием и предпросмотром. */
  extraMounts?: string[];
};

export type SandboxHostStatus = {
  mode: string;
  available: boolean;
  reason?: string;
  detail?: string;
  dockerVersion?: string;
  /** Observed capacity, when the host can provide it (remote runners do). */
  metrics?: {
    memoryTotalMb: number;
    memoryUsedMb: number;
    containers: number;
  };
  /** The runner reports the path it mounted; the API can compare it with its own shared mount. */
  workspace?: {
    root: string;
    hostRoot: string;
    shared: boolean;
  };
  previewNetwork?: string;
  previewAttachNetworks?: string[];
  nodeId?: string;
};

/**
 * The execution boundary of the platform.
 *
 * `local` runs Docker on the API VM. A remote host is an authenticated runner on a private
 * network: it accepts project-scoped commands, the hardened Docker operations the preview and
 * job code need, and preview relay requests. It never receives the platform database, payment
 * keys or the project archive credentials.
 *
 * `id` is the registry node id (`local` by default); a remote host registers the same id it
 * reports in its heartbeat.
 */
export type SandboxHost = {
  readonly id: string;
  status(): Promise<SandboxHostStatus>;
  /**
   * `config.root` and `cwd` are paths on this host. A remote implementation maps them to its
   * own workspace mount; the command, limits and cancellation semantics stay the same.
   */
  runCommand(
    config: SandboxConfig,
    command: string,
    cwd: string,
    options?: SandboxRunOptions,
  ): Promise<DockerCommandResult>;
  /**
   * Low-level container operation for preview/job lifecycle. Paths in `args` are host paths:
   * a remote implementation must translate them to its own workspace mount, exactly as the
   * local Docker daemon resolves them on this VM.
   */
  docker(args: string[], timeoutMs?: number): Promise<DockerCliResult>;
  /** Preview networks as they exist on this host, not on the API VM. */
  networks?(): Promise<{ preview: string; attach: string[] }>;
  /**
   * A private TCP relay from the runner to a preview container. The API cannot route to the
   * runner's Docker bridge on another VM; this is what carries HTTP and HMR WebSockets.
   */
  previewRelay?(containerId: string, targetPort: number): Promise<{ host: string; port: number } | null>;
};

export class SandboxNodeUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "NODE_UNAVAILABLE";
  constructor(readonly node: string, reason: string) {
    super("Узел " + node + " недоступен: " + reason);
    this.name = "SandboxNodeUnavailableError";
  }
}

/**
 * Remote execution requires one hot workspace shared by the API and the runner. Without it the
 * API would read an empty local directory, place files on the wrong machine and start a preview
 * from a project the runner cannot see. The deployment must opt in explicitly.
 */
export class SharedWorkspaceRequiredError extends Error {
  readonly statusCode = 503;
  readonly code = "SHARED_WORKSPACE_REQUIRED";
  constructor(readonly node: string, reason: string) {
    super("Узел " + node + " требует общего каталога проектов: " + reason);
    this.name = "SharedWorkspaceRequiredError";
  }
}

const hosts = new Map<string, SandboxHost>([[localSandboxHost.id, localSandboxHost]]);

// One active host per server process. Stage 3 sets it from the node registry; until then this is
// the local node and every call keeps its previous behavior.
let active: SandboxHost = localSandboxHost;

export function sandboxHost(): SandboxHost {
  return active;
}

/**
 * Resolve the host for a project's pinned node. There is no `?? local` fallback: executing a
 * project on the API machine when its files are pinned to another node would be worse than a
 * clear failure, and it would hide a missing runner during stage 3.
 */
export function sandboxHostForNode(id: string): SandboxHost {
  const host = hosts.get(id);
  if (!host) throw new Error("Узел " + id + " не подключён: runner недоступен");
  return host;
}

/**
 * Async resolver used by request paths. A runner is registered lazily after the node registry
 * has been read; the token stays on the API and is never stored with the project.
 */
export async function resolveSandboxHost(id: string): Promise<SandboxHost> {
  const existing = hosts.get(id);
  if (existing) return existing;
  const node = await getNode(id);
  if (!node) throw new SandboxNodeUnavailableError(id, "нет записи в реестре узлов");
  // Draining stops new placement; projects already pinned there keep executing until an
  // operator migrates them. Offline is the only status that makes an existing project
  // unservable.
  if (node.status === "offline") throw new SandboxNodeUnavailableError(id, "узел выведен из обслуживания (offline)");
  if (!node.address.trim()) {
    throw new SandboxNodeUnavailableError(id, "не задан адрес runner (WEBNESTDEV_NODE_ADDRESS)");
  }
  const token = process.env.WEBNESTDEV_RUNNER_TOKEN?.trim() ?? "";
  if (token.length < 32) {
    throw new SandboxNodeUnavailableError(id, "на API не задан WEBNESTDEV_RUNNER_TOKEN (не короче 32 символов)");
  }
  const host = createRemoteSandboxHost({ id, address: node.address, token });
  if (!isNodeFresh(node)) {
    // A restart or a short poll gap must not make a pinned project look lost. Ask the runner
    // once, and let the registry catch up before deciding that the node is gone.
    try {
      const status = await host.status();
      if (!status.metrics) throw new Error("runner не вернул метрики");
      const now = new Date().toISOString();
      const updated = await updateNodeMetrics({
        id: node.id,
        address: node.address,
        memoryTotalMb: status.metrics.memoryTotalMb,
        memoryUsedMb: status.metrics.memoryUsedMb,
        containers: status.metrics.containers,
        lastSeenAt: now,
        updatedAt: now,
      });
      if (!updated) throw new Error("узел исчез из реестра");
    } catch (error) {
      throw new SandboxNodeUnavailableError(
        id,
        "heartbeat устарел: " + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  registerSandboxHost(host);
  return host;
}

/** Register a runner host under its stable node id. Used by the stage 3.2 remote host. */
export function registerSandboxHost(host: SandboxHost) {
  hosts.set(host.id, host);
}

/** Drop a cached remote host when an operator makes the node unservable. */
export function unregisterSandboxHost(id: string) {
  if (id !== localSandboxHost.id) hosts.delete(id);
}

/**
 * Replace the active host. Exported for the node registry and tests; production has no
 * user-facing switch yet, so nothing can silently point at a different machine.
 */
export function useSandboxHost(host: SandboxHost | null) {
  active = host ?? localSandboxHost;
  if (host) registerSandboxHost(host);
}

/** Reset the lazy host cache between tests. Not used by production request paths. */
export function clearSandboxHostsForTests() {
  for (const id of [...hosts.keys()]) {
    if (id !== localSandboxHost.id) hosts.delete(id);
  }
  active = localSandboxHost;
}
