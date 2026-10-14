import { runDockerSandbox, type DockerCommandResult } from "./docker-sandbox.js";
import { withSandboxSlot } from "./sandbox/sandbox-limiter.js";
import type { SandboxConfig } from "./sandbox-manager.js";
export type CommandResult = DockerCommandResult;
export type SandboxRunOptions = { network?: "none"|"bridge" };
/**
 * Every container command in the platform goes through here — the agent's `terminal.exec`,
 * `npm.install`, the git tools, the project terminal in the panel and the preview build — so
 * this is the single place where the host's container limit is enforced. A command that arrives
 * while the limit is reached waits for a place instead of starting another container.
 */
export async function runInSandbox(config:SandboxConfig,command:string,cwd:string,options:SandboxRunOptions={}):Promise<CommandResult>{
  return withSandboxSlot(()=>runDockerSandbox(config,command,cwd,options));
}
