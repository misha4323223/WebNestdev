import { mkdir } from "node:fs/promises";
import { getProject } from "../project-store.js";
import { ensureProjectWorkspace, noteProjectAccess } from "../storage/project-archive.js";
import { buildSandboxConfig,sandboxRootPath } from "./config.js";
import { openDirForSandbox,openTreeForSandbox } from "./permissions.js";
import type { SandboxConfig } from "./sandbox-types.js";

/**
 * Command and preview containers run as uid 1000 while the server writes the project as root, so
 * the project directory is opened to every writer once: without it the containers can read the
 * agent's files but not install packages or rebuild the app inside them.
 *
 * The root alone is not enough — a project with subdirectories (server/, packages/) keeps its
 * files inside those, and a root-owned 755 directory is where a build stops with EPERM. So the
 * existing tree is opened too, once per project per process; every later write by the server
 * reopens what it created (see tools/filesystem-tools.ts).
 */
const opened=new Map<string,Promise<void>>();

function openToSandboxUser(root:string){
  const pending=opened.get(root);
  if(pending)return pending;
  const run=openDirForSandbox(root).then(()=>openTreeForSandbox(root));
  opened.set(root,run);
  return run;
}

/**
 * Песочница выдаётся только владельцу проекта. `userId` обязателен: необязательный параметр
 * означал, что любой новый маршрут, забывший его передать, получал чужой каталог без проверки.
 * Права проверяются и в маршруте (`requireProjectUser`), и здесь — на случай будущих вызовов.
 */
export async function getSandbox(projectId:string,userId:string):Promise<SandboxConfig>{
  const project=await getProject(projectId);
  if(!project || project.userId!==userId)throw new Error("Проект не найден");
  const root=sandboxRootPath(projectId);
  // Проект может лежать в объектном хранилище (холодный ярус): панель, агент и предпросмотр
  // работают с обычной папкой, поэтому первый доступ возвращает её на диск.
  await ensureProjectWorkspace(projectId,userId);
  // Отметка для фоновой архивации: открытый проект не должен уехать в бакет под руками.
  noteProjectAccess(projectId);
  await mkdir(root,{recursive:true});
  await openToSandboxUser(root);
  return buildSandboxConfig(projectId,root);
}
