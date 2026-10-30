import { sandboxImage, sandboxRuntime } from "../config.js";
import type { SandboxConfig } from "../sandbox-types.js";
import type { DockerSandboxOptions } from "./types.js";

export function dockerOptions(config:SandboxConfig):DockerSandboxOptions{
  return {
    image:sandboxImage(),
    memory:process.env.SANDBOX_MEMORY??String(config.memoryMb)+"m",
    cpus:process.env.SANDBOX_CPUS??String(config.cpuLimit),
    pids:process.env.SANDBOX_PIDS_LIMIT??"128",
    network:process.env.SANDBOX_NETWORK??"none",
    maxOutput:Number(process.env.TOOL_COMMAND_MAX_OUTPUT??200000),
    runtime:sandboxRuntime()
  };
}
