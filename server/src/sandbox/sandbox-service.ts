import { mkdir } from "node:fs/promises";
import { getProject } from "../project-store.js";
import { buildSandboxConfig,sandboxRootPath } from "./config.js";
import type { SandboxConfig } from "./sandbox-types.js";

export async function getSandbox(projectId:string):Promise<SandboxConfig>{
  if(!await getProject(projectId))throw new Error("Project not found");
  const root=sandboxRootPath(projectId);
  await mkdir(root,{recursive:true});
  return buildSandboxConfig(projectId,root);
}
