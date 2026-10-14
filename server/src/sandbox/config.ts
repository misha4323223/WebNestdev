import path from "node:path";
import type { SandboxConfig } from "./sandbox-types.js";

const sandboxRoot=path.resolve(process.env.WEBNESTDEV_SANDBOX_DIR??".webnestdev/sandboxes");

/**
 * The same directory as the Docker daemon sees it. A `-v` path is resolved on the host, never
 * inside this process, so when the server itself runs in a container the two paths differ — and a
 * container that mounts the wrong one sees an empty `/workspace` while the file tools keep showing
 * the real files. `WEBNESTDEV_SANDBOX_HOST_DIR` is that host path; without it the directory is
 * taken to be mounted at the same place on both sides, which is the plain-host case.
 */
const sandboxHostRoot=path.resolve(process.env.WEBNESTDEV_SANDBOX_HOST_DIR??process.env.WEBNESTDEV_SANDBOX_DIR??".webnestdev/sandboxes");

/** The directory every project lives in — the path health reports free space for. */
export function sandboxRootDir(){return sandboxRoot}

/** Where the sandbox containers look for their projects: the source of every `-v`. */
export function sandboxHostRootDir(){return sandboxHostRoot}

export function sandboxRootPath(projectId:string){return path.join(sandboxRoot,projectId)}

/**
 * The host path of one project directory, derived from the server path by swapping the root. One
 * setting keeps every container mount correct without teaching the callers about the two sides.
 */
export function hostPathFor(root:string,roots={serverDir:sandboxRoot,hostDir:sandboxHostRoot}){
  if(roots.hostDir===roots.serverDir)return root;
  const relative=path.relative(roots.serverDir,root);
  if(!relative)return roots.hostDir;
  if(relative.startsWith("..")||path.isAbsolute(relative))return root;
  return path.join(roots.hostDir,relative);
}

/** What a container mounts for a project: the host side of the directory, not the server side. */
export function workspaceMountSource(config:{root:string;hostRoot?:string}){return config.hostRoot??config.root}

/** The two paths in one line, for the startup log and `/api/health`. */
export function describeSandboxPaths(){
  const same=sandboxHostRoot===sandboxRoot;
  return `каталог песочниц: сервер ${sandboxRoot}`+(same?"":"; для docker — "+sandboxHostRoot);
}

export function buildSandboxConfig(projectId:string,root:string):SandboxConfig{
  return {
    projectId,
    root,
    hostRoot:hostPathFor(root),
    memoryMb:Number(process.env.SANDBOX_MEMORY_MB??1024),
    cpuLimit:Number(process.env.SANDBOX_CPU_LIMIT??1),
    timeoutMs:Number(process.env.TOOL_COMMAND_TIMEOUT_MS??120000)
  };
}
