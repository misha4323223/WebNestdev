import type { SandboxConfig } from "../sandbox-manager.js";
import { nodeId } from "../nodes/identity.js";
import { runDockerSandbox, sandboxStatus } from "../docker-sandbox.js";
import { runDockerCli } from "./docker/cli.js";
import type { DockerCliResult, DockerCommandResult } from "./docker/types.js";
import type { SandboxHost, SandboxHostStatus, SandboxRunOptions } from "./host.js";

type LocalSandboxHostDeps = {
  status?: () => Promise<SandboxHostStatus>;
  runCommand?: (
    config: SandboxConfig,
    command: string,
    cwd: string,
    options: SandboxRunOptions,
  ) => Promise<DockerCommandResult>;
  docker?: (args: string[], timeoutMs?: number) => Promise<DockerCliResult>;
};

/**
 * The local node's implementation. It is intentionally thin: `runDockerSandbox` keeps the
 * streaming, cancellation and output-limit behavior, while `runDockerCli` is the same
 * inspect/logs/exec/network path previews and jobs already used. No command construction or
 * security flags move here — those stay next to the operation that needs them.
 */
export function createLocalSandboxHost(deps: LocalSandboxHostDeps = {}): SandboxHost {
  const run = deps.runCommand ?? runDockerSandbox;
  const docker = deps.docker ?? runDockerCli;
  const status = deps.status ?? sandboxStatus;
  return {
    id: nodeId(),
    status: () => status(),
    runCommand: (config, command, cwd, options = {}) => run(config, command, cwd, options),
    docker: (args, timeoutMs) => docker(args, timeoutMs),
  };
}

export const localSandboxHost = createLocalSandboxHost();
