import { chmod,mkdir } from "node:fs/promises";
import { getProject } from "../project-store.js";
import { buildSandboxConfig,sandboxRootPath } from "./config.js";
import type { SandboxConfig } from "./sandbox-types.js";

/**
 * Command and preview containers run as uid 1000 while the server writes the project as
 * root, so the project directory is opened to every writer once: without it the containers
 * can read the agent's files but not install packages or rebuild the app inside them.
 */
async function openToSandboxUser(root:string){
  try{await chmod(root,0o777)}catch(error){console.error(`[sandbox] не удалось выставить права на ${root}`,error)}
}

export async function getSandbox(projectId:string,userId?:string):Promise<SandboxConfig>{
  const project=await getProject(projectId);
  if(!project || (userId && project.userId!==userId))throw new Error("Проект не найден");
  const root=sandboxRootPath(projectId);
  await mkdir(root,{recursive:true});
  await openToSandboxUser(root);
  return buildSandboxConfig(projectId,root);
}
