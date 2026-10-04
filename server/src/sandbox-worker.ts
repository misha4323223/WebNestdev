import { runDockerSandbox, type DockerCommandResult } from "./docker-sandbox.js";
import type { SandboxConfig } from "./sandbox-manager.js";
export type CommandResult = DockerCommandResult;
export async function runInSandbox(config:SandboxConfig,command:string,cwd:string):Promise<CommandResult>{return runDockerSandbox(config,command,cwd)}
