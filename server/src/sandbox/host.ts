import type { SandboxConfig } from "../sandbox-manager.js";
import type { DockerCliResult, DockerCommandResult } from "./docker/types.js";
import { localSandboxHost } from "./local-host.js";

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
};

/**
 * The execution boundary of the platform.
 *
 * Today the only implementation is local: the API and Docker live on the same VM. The contract
 * is deliberately small because the call sites use Docker CLI operations directly — commands,
 * jobs, previews, network inspection and exec. A remote runner will implement `docker` as an
 * allowlisted operation on its own node, while `runCommand` keeps the streaming/cancellation
 * semantics. The rest of the server should ask this host, not spawn Docker itself.
 *
 * `id` is the registry node id (`local` by default); a remote host registers the same id it
 * reports in a node heartbeat.
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
};

const hosts = new Map<string, SandboxHost>([[localSandboxHost.id, localSandboxHost]]);

// One active host per server process. Stage 3 will set it from the node registry; until then
// this is the local node and every call keeps its previous behavior.
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

/** Register a runner host under its stable node id. Used by the stage 3.2 remote host. */
export function registerSandboxHost(host: SandboxHost) {
  hosts.set(host.id, host);
}

/**
 * Replace the active host. Exported for the node registry and tests; production has no
 * user-facing switch yet, so nothing can silently point at a different machine.
 */
export function useSandboxHost(host: SandboxHost | null) {
  active = host ?? localSandboxHost;
  if (host) registerSandboxHost(host);
}
