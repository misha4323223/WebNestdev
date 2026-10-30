import path from "node:path";
import { nodeId } from "../nodes/identity.js";
import type { SandboxConfig } from "./sandbox-types.js";

/**
 * Образ, в котором выполняются команды агента, `npm install` и контейнер предпросмотра.
 *
 * Это не `-slim`, и причина одна: инструментам агента нужен `git`, а в slim-варианте его нет —
 * `git status` отвечал `/bin/sh: 1: git: not found` (код 127), и «Работа с Git» выглядела сломанной,
 * хотя платформа умеет работать с историей проекта. Полный образ Node собран на buildpack-deps: там
 * есть git, make и компилятор, поэтому ставится и нативный `npm install`, и зависимость из git-URL.
 *
 * Значение живёт в одном месте: раньше `node:22-bookworm-slim` был вписан отдельно в песочницу,
 * предпросмотр, проверки и compose, и достаточно было поправить одно место, чтобы они разошлись.
 * Свой образ (в том числе slim с git) задаётся через `SANDBOX_IMAGE`.
 */
export const DEFAULT_SANDBOX_IMAGE="node:22-bookworm";

/** Образ песочницы из окружения; пустая строка — это «не задано», а не имя образа. */
export function sandboxImage(){
  return process.env.SANDBOX_IMAGE?.trim()||DEFAULT_SANDBOX_IMAGE;
}

/**
 * Рантайм контейнеров проекта. `docker` — обычный runc (поведение до этапа 2), `runsc` — gVisor.
 *
 * Значение читается при каждом запуске контейнера, а не один раз на импорте: переключатель должен
 * работать без пересборки, а тест может подменить окружение. Неизвестное значение — ошибка, а не
 * молчаливый возврат к runc: иначе опечатка в `.env` выглядела бы как «gVisor включён», хотя
 * контейнеры остались на общем ядре.
 */
export type SandboxRuntime="docker"|"runsc";
export function sandboxRuntime(setting:string|undefined=process.env.SANDBOX_RUNTIME):SandboxRuntime{
  const value=(setting??"docker").trim().toLowerCase();
  if(!value||value==="docker")return "docker";
  if(value==="runsc")return "runsc";
  throw new Error('SANDBOX_RUNTIME="'+value+'" не поддерживается: используйте docker или runsc');
}

/** Аргументы Docker CLI для выбранного рантайма; для обычного Docker их нет. */
export function sandboxRuntimeArgs():string[]{
  return sandboxRuntime()==="runsc"?["--runtime=runsc"]:[];
}

/** Строка для старта и health: какой рантайм реально выбран. */
export function describeSandboxRuntime(){
  const runtime=sandboxRuntime();
  return "рантайм контейнеров: "+runtime+(runtime==="runsc"?" (gVisor)":" (runc)");
}

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

/** Memory a project container normally receives; also the reservation used by node placement. */
export function sandboxMemoryMb(){
  const value=Number(process.env.SANDBOX_MEMORY_MB??1024);
  return Number.isFinite(value)&&value>0?value:1024;
}

export function buildSandboxConfig(projectId:string,root:string,node=nodeId()):SandboxConfig{
  return {
    projectId,
    root,
    hostRoot:hostPathFor(root),
    node,
    memoryMb:sandboxMemoryMb(),
    cpuLimit:Number(process.env.SANDBOX_CPU_LIMIT??1),
    timeoutMs:Number(process.env.TOOL_COMMAND_TIMEOUT_MS??120000)
  };
}
