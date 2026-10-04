import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getProject } from "./project-store.js";
export type SandboxConfig={projectId:string;root:string;memoryMb:number;cpuLimit:number;timeoutMs:number};
const sandboxRoot=path.resolve(process.env.WEBNESTDEV_SANDBOX_DIR??".webnestdev/sandboxes");
export async function getSandbox(projectId:string):Promise<SandboxConfig>{if(!await getProject(projectId))throw new Error("Project not found");const root=path.join(sandboxRoot,projectId);await mkdir(root,{recursive:true});return{projectId,root,memoryMb:Number(process.env.SANDBOX_MEMORY_MB??1024),cpuLimit:Number(process.env.SANDBOX_CPU_LIMIT??1),timeoutMs:Number(process.env.TOOL_COMMAND_TIMEOUT_MS??120000)}}
export function assertInsideSandbox(root:string,candidate:string){const r=path.resolve(root),c=path.resolve(candidate);if(c!==r&&!c.startsWith(r+path.sep))throw new Error("Path escapes sandbox");return c}