import path from "node:path";
import type { SandboxConfig } from "./sandbox-types.js";

const sandboxRoot=path.resolve(process.env.WEBNESTDEV_SANDBOX_DIR??".webnestdev/sandboxes");

export function sandboxRootPath(projectId:string){return path.join(sandboxRoot,projectId)}

export function buildSandboxConfig(projectId:string,root:string):SandboxConfig{
  return {
    projectId,
    root,
    memoryMb:Number(process.env.SANDBOX_MEMORY_MB??1024),
    cpuLimit:Number(process.env.SANDBOX_CPU_LIMIT??1),
    timeoutMs:Number(process.env.TOOL_COMMAND_TIMEOUT_MS??120000)
  };
}
