import { runDockerSandbox, type DockerCommandResult } from "./docker-sandbox.js";
import type { SandboxConfig } from "./sandbox-manager.js";
export type CommandResult = DockerCommandResult;
export type SandboxRunOptions = { network?: "none"|"bridge" };
export async function runInSandbox(config:SandboxConfig,command:string,cwd:string,options:SandboxRunOptions={}):Promise<CommandResult>{
  return runDockerSandbox(config,command,cwd,options);
}
