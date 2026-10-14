import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sandboxHostRootDir,sandboxRootDir } from "./config.js";

/**
 * Prefix of the marker file the check writes and a container reads back through the mounted
 * directory. Every run appends its own token, because two checks can overlap — the deploy runs one
 * while the freshly started server runs its startup one — and a shared file name made each of them
 * overwrite the marker of the other, which looked exactly like a real path mismatch.
 */
export const MOUNT_MARKER_FILE=".webnestdev-mount-check";

/**
 * Why the round trip failed.
 *
 * `mismatch` is the one that breaks the product: the server writes project files into one directory
 * while the containers get a different one mounted, so the sandbox terminal shows an empty
 * `/workspace` for files the agent has just written — and the agent, and then the user, reads that
 * as "the files disappeared". `image` and `docker` are host problems and `disk` means the marker
 * could not even be written.
 */
export type SandboxMountReason="docker"|"image"|"disk"|"mismatch";
export type SandboxMountCheck={ok:boolean;serverDir:string;hostDir:string;image:string;reason?:SandboxMountReason;detail?:string;checkedAt:number};

/**
 * A missing image and an unreachable daemon both come back as a failed `docker run`, so the message
 * decides which of the two it was. `--pull=never` is deliberate: it turns "image not downloaded yet"
 * into an immediate, named answer instead of a silent pull that hides the failure behind a network.
 */
export function classifyDockerFailure(stderr:string):SandboxMountReason{
  return /pull access denied|no such image|manifest unknown|not found|unauthorized/i.test(stderr)?"image":"docker";
}

export function markerMatches(expected:string,stdout:string){return stdout.trim()===expected}

function tail(value:string,max=400){const text=value.trim();return text.length>max?text.slice(-max):text}

function dockerRun(args:string[],timeoutMs:number){
  return new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn("docker",args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="";
    child.stdout.on("data",(chunk:Buffer)=>{stdout+=chunk.toString()});
    child.stderr.on("data",(chunk:Buffer)=>{stderr+=chunk.toString()});
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error("Проверка монтирования песочницы не ответила вовремя"))},timeoutMs);
    child.once("error",error=>{clearTimeout(timer);reject(error)});
    child.once("close",code=>{clearTimeout(timer);resolve({code:code??1,stdout,stderr})});
  });
}

/**
 * Writes a marker into the sandbox directory and asks a container to read it back through the same
 * mount a command uses. Everything else about the sandbox is a matter of configuration; this is the
 * one property that cannot be checked by reading files in this process, because the container's view
 * of the directory is made by the Docker daemon on the host.
 */
export async function checkSandboxMount(options:{serverDir?:string;hostDir?:string;image?:string;timeoutMs?:number}={}):Promise<SandboxMountCheck>{
  const serverDir=options.serverDir??sandboxRootDir();
  const hostDir=options.hostDir??sandboxHostRootDir();
  const image=options.image??process.env.SANDBOX_IMAGE??"node:22-bookworm-slim";
  const timeoutMs=options.timeoutMs??30000;
  const token=randomUUID();
  const markerName=`${MOUNT_MARKER_FILE}-${token}`;
  const marker=path.join(serverDir,markerName);
  const base={serverDir,hostDir,image,checkedAt:Date.now()};
  // Относительный путь docker разбирает от корня хоста, а сервер — от своего рабочего каталога:
  // такой `-v` монтирует чужой каталог или не монтируется вовсе. Это тот же дефект, поэтому и
  // обнаруживается сразу, без запуска контейнера.
  const relative=[serverDir,hostDir].find(value=>!path.isAbsolute(value));
  if(relative)return {...base,ok:false,reason:"mismatch",detail:`путь песочницы относительный: ${relative}`};
  try{
    await mkdir(serverDir,{recursive:true});
    await writeFile(marker,token,"utf8");
  }catch(error){
    return {...base,ok:false,reason:"disk",detail:tail(error instanceof Error?error.message:String(error))};
  }
  const mount=["--rm","--pull=never","--network","none","--user","1000:1000","-v",hostDir+":/workspace","-w","/workspace",image];
  try{
    const read=await dockerRun(["run",...mount,"/bin/sh","-lc","cat /workspace/"+markerName],timeoutMs);
    if(read.code!==0){
      return {...base,ok:false,reason:classifyDockerFailure(read.stderr),detail:tail(read.stderr||`docker run завершился с кодом ${read.code}`)};
    }
    if(markerMatches(token,read.stdout))return {...base,ok:true};
    // Что именно видно в контейнере — самое полезное в отчёте: пустая папка или чужие файлы.
    // Идущие параллельно проверки не считаем: их маркеры исчезают вместе с ними.
    const listing=await dockerRun(["run",...mount,"/bin/sh","-lc",`ls -A /workspace 2>/dev/null | grep -v "^${MOUNT_MARKER_FILE}" | head -20`],timeoutMs).catch(()=>null);
    const seen=listing&&listing.code===0?listing.stdout.trim():"";
    return {...base,ok:false,reason:"mismatch",detail:`маркер ${markerName} не виден контейнеру; в /workspace контейнера: ${seen?seen.split("\n").join(", "):"пусто"}`};
  }catch(error){
    return {...base,ok:false,reason:"docker",detail:tail(error instanceof Error?error.message:String(error))};
  }finally{
    await rm(marker,{force:true}).catch(()=>{});
  }
}

/**
 * How many files each side sees in the sandbox directory. The marker proves the directory is shared;
 * the two counts are the operator's evidence that a migration actually carried the projects over
 * (they can differ while an agent is writing, so this is a number to read, not a verdict).
 */
export async function sandboxFileCounts(options:{serverDir?:string;hostDir?:string;image?:string;timeoutMs?:number}={}){
  const serverDir=options.serverDir??sandboxRootDir();
  const hostDir=options.hostDir??sandboxHostRootDir();
  const image=options.image??process.env.SANDBOX_IMAGE??"node:22-bookworm-slim";
  const timeoutMs=options.timeoutMs??30000;
  const container=await dockerRun(["run","--rm","--pull=never","--network","none","--user","1000:1000","-v",hostDir+":/workspace","-w","/workspace",image,"/bin/sh","-lc","find /workspace -type f 2>/dev/null | wc -l"],timeoutMs).catch(()=>null);
  const parsed=container&&container.code===0?Number(container.stdout.trim()):NaN;
  return {server:await countFiles(serverDir),container:Number.isFinite(parsed)?parsed:null};
}

/** Files under a directory, with a bound so a huge project cannot turn a check into a scan. */
export async function countFiles(dir:string,max=5000){
  let total=0;
  const walk=async(current:string)=>{if(total>=max)return;let entries;try{entries=await readdir(current,{withFileTypes:true})}catch{return}for(const entry of entries){if(total>=max)return;if(entry.isDirectory())await walk(path.join(current,entry.name));else if(entry.isFile())total++}};
  await walk(dir);
  return total;
}

/** The last result, so `/api/health` can answer for free instead of repeating the round trip. */
let lastCheck:SandboxMountCheck|null=null;
export function rememberSandboxMountCheck(result:SandboxMountCheck){lastCheck=result;return result}
export function lastSandboxMountCheck(){return lastCheck}

/** One line for the startup log, the deploy script and the operator: what is wrong, what to change. */
export function describeSandboxMount(result:SandboxMountCheck){
  const where=`сервер ${result.serverDir}, контейнеры монтируют ${result.hostDir}`;
  if(result.ok)return `песочница доступна контейнерам: ${where}`;
  if(result.reason==="mismatch")return `РАСХОЖДЕНИЕ путей песочницы: ${where}. Команды агента пишут файлы в каталог сервера, а терминал песочницы видит другой каталог — задайте WEBNESTDEV_SANDBOX_DIR (и WEBNESTDEV_SANDBOX_HOST_DIR, когда пути различаются) и смонтируйте этот каталог в контейнер сервера тем же абсолютным путём`;
  if(result.reason==="image")return `образ песочницы ${result.image} недоступен: ${result.detail}`;
  if(result.reason==="disk")return `каталог песочницы ${result.serverDir} недоступен для записи: ${result.detail}`;
  return `Docker недоступен для проверки песочницы: ${result.detail}`;
}

export async function verifySandboxMount(){return rememberSandboxMountCheck(await checkSandboxMount())}
