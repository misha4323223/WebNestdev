import Fastify,{type FastifyInstance} from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { runInSandbox } from "../sandbox-worker.js";
import type { DockerCommandResult } from "../sandbox/docker/types.js";
import type { SandboxConfig } from "../sandbox-manager.js";
import { setPreview,touchPreview } from "./preview-store.js";
import { indexFileExists,isStaticBuildFresh,planStaticPreview } from "./static-plan.js";
import type { PreviewStatus } from "./types.js";

/**
 * The static preview mode: the project is built once and the output is served by the server
 * process itself, so showing a project costs no container and no memory. It replaces the
 * per-project dev-server container, which is what fills a small host up.
 *
 * The whole flow stays inside the existing preview contract — the state still carries
 * `host`/`port` — so the proxy route, `project.verify`, `browser.*` and the idle sweeper work
 * unchanged. Only the readiness probe differs: nothing runs inside a container, so the app is
 * asked over HTTP instead of through `docker exec`.
 */

/** The listener binds the loopback address: only the server itself talks to a static preview. */
const STATIC_HOST="127.0.0.1";
/** One build's output is the whole log; the panel shows it instead of dev-server output. */
const MAX_LOG_CHARS=8000;
/** The build is one sandbox command, so a project that cannot build falls back quickly. */
const BUILD_COMMAND="npm run build";

export type PreviewModeSetting="auto"|"static"|"container";
export type StaticBuildSetting="auto"|"always"|"never";

/**
 * `container` keeps the old behaviour, `static` refuses to fall back when a project cannot be
 * served statically (a host that must not run preview containers), and `auto` — the default —
 * serves the build when there is one and uses the dev-server container otherwise.
 */
export function previewModeSetting():PreviewModeSetting{
  const value=(process.env.PREVIEW_MODE??"").trim().toLowerCase();
  return value==="static"||value==="container"?value:"auto";
}

export function staticBuildSetting():StaticBuildSetting{
  const value=(process.env.PREVIEW_STATIC_BUILD??"").trim().toLowerCase();
  return value==="always"||value==="never"?value:"auto";
}

/** Printed once at startup: which preview mode this host actually runs. */
export function describePreviewMode(){
  const setting=previewModeSetting();
  if(setting==="container")return "container (dev-сервер в контейнере на каждый проект)";
  if(setting==="static")return "static (только сборка, без контейнера предпросмотра)";
  return "auto (статическая сборка, иначе dev-сервер)";
}

type StaticRun={server:FastifyInstance;dir:string;port:number;log:string;builtAt:number;startedAt:number};

const runs=new Map<string,StaticRun>();

export type StaticStartResult={ok:true;status:PreviewStatus}|{ok:false;reason:string};

/**
 * Serves the built app for this project, building it first when the output is missing or
 * older than the sources. A preview that is already serving exactly this build is reused, so
 * opening the panel twice does not rebuild anything.
 *
 * A failure is returned as a reason instead of thrown: the caller decides whether the reason
 * becomes a fallback to the dev server (`auto`) or an error (`static`).
 */
export async function startStaticPreview(config:SandboxConfig):Promise<StaticStartResult>{
  const plan=await planStaticPreview(config);
  if(!plan.ok)return plan;
  const previous=runs.get(config.projectId);
  const build=staticBuildSetting();
  const builtAt=previous?.builtAt??0;
  const fresh=await isStaticBuildFresh(config.root,plan.dir,builtAt);
  const needsBuild=build==="always"||(build!=="never"&&!fresh);

  if(previous&&!needsBuild){
    touchPreview(config.projectId);
    return {ok:true,status:statusFor(previous)};
  }
  if(previous)await stopStaticPreview(config.projectId);

  let log="";
  let marker=previous?.builtAt??0;
  if(needsBuild){
    const result=await runBuild(config);
    if(!("ok" in result))return {ok:false,reason:result.reason};
    log=buildLog(result);
    marker=Date.now();
  }
  if(!await indexFileExists(plan.dir)){
    return {ok:false,reason:(needsBuild?"сборка не создала ":"нет ")+relative(plan.dir,config.root)+"/index.html"};
  }

  const listener=await listenStatic(plan.dir);
  const run:StaticRun={server:listener.app,dir:plan.dir,port:listener.port,log,builtAt:marker,startedAt:Date.now()};
  runs.set(config.projectId,run);
  setPreview({mode:"static",containerId:"",host:STATIC_HOST,port:run.port,projectId:config.projectId,startedAt:run.startedAt,lastUsedAt:run.startedAt});
  return {ok:true,status:statusFor(run)};
}

export async function stopStaticPreview(projectId:string){
  const run=runs.get(projectId);
  if(!run)return;
  runs.delete(projectId);
  const closing=run.server.close().catch(()=>undefined);
  // close() waits for connections that are already open, and a browser keeps its sockets
  // alive; the preview must free its port at once, so the leftovers are dropped.
  run.server.server.closeIdleConnections?.();
  run.server.server.closeAllConnections?.();
  await closing;
}

/** Used by tests to clean up every listener this process started. */
export async function stopAllStaticPreviews(){
  for(const projectId of [...runs.keys()])await stopStaticPreview(projectId);
}

/**
 * The build output is the only log a static preview has, so the panel shows it together with
 * a line explaining why there is no dev-server output. A preview that was reused keeps the log
 * of the build it is serving.
 */
export function staticPreviewLogs(projectId:string){
  const run=runs.get(projectId);
  if(!run)return "";
  const header="Статический предпросмотр: приложение отдаётся из "+run.dir+", горячей перезагрузки нет — обновление после сборки.";
  return run.log?header+"\n\n"+run.log:header;
}

/** Nothing runs in a container here, so readiness is a plain HTTP question. */
export async function staticAppAnswers(host:string,port:number){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),5000);
  try{
    const response=await fetch("http://"+host+":"+port+"/",{signal:controller.signal,redirect:"manual"});
    return response.status<500;
  }catch{
    return false;
  }finally{
    clearTimeout(timer);
  }
}

function statusFor(run:StaticRun):PreviewStatus{
  return {running:true,ready:true,port:run.port,host:STATIC_HOST,containerId:"",startedAt:run.startedAt,mode:"static"};
}

async function runBuild(config:SandboxConfig):Promise<DockerCommandResult|{reason:string}>{
  try{
    return await runInSandbox(config,BUILD_COMMAND,config.root);
  }catch(error){
    return {reason:"сборка не запустилась: "+(error instanceof Error?error.message:String(error))};
  }
}

/** The tail of the build output plus the failure line: enough to fix the project from the log. */
function buildLog(result:DockerCommandResult){
  const output=[result.stdout,result.stderr].map(value=>value.replace(/\r/g,"").trim()).filter(Boolean).join("\n");
  const head="$ "+BUILD_COMMAND+(result.ok?"":failureLine(result));
  const body=output.length>MAX_LOG_CHARS?output.slice(-MAX_LOG_CHARS):output;
  return body?head+"\n"+body:head;
}

function failureLine(result:DockerCommandResult){
  const failed=result.stderr.split("\n").map(line=>line.trim()).filter(Boolean).at(-1);
  return " → "+(failed??("код выхода "+result.exitCode));
}

/**
 * A tiny Fastify instance serving the build output, the same way the platform's own frontend
 * is served. An unknown path without a file extension is a client-side route, so index.html is
 * returned; a missing asset keeps its 404 instead of silently becoming HTML.
 */
async function listenStatic(dir:string){
  const app=Fastify({logger:false,disableRequestLogging:true});
  await app.register(fastifyStatic,{root:dir,index:["index.html"],maxAge:0,cacheControl:true});
  app.setNotFoundHandler((request,reply)=>{
    if((request.method==="GET"||request.method==="HEAD")&&!looksLikeFile(request.raw.url??"")){
      return reply.sendFile("index.html",{maxAge:0,immutable:false});
    }
    return reply.code(404).send({error:"Not Found"});
  });
  await app.listen({host:STATIC_HOST,port:0});
  const address=app.server.address();
  const port=typeof address==="object"&&address?address.port:0;
  if(!port){
    await app.close().catch(()=>undefined);
    throw new Error("Не удалось определить порт статического предпросмотра");
  }
  return {app,port};
}

function looksLikeFile(url:string){
  const pathname=url.split(/[?#]/)[0];
  return /\.[a-z0-9]{1,8}$/i.test(pathname);
}

/** The output directory as the project sees it, for a message the user can act on. */
function relative(dir:string,root:string){
  const value=path.relative(root,dir).replaceAll("\\","/");
  return value&&!value.startsWith(".")?value:dir;
}
