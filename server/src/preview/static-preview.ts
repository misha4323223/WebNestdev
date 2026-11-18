import Fastify,{type FastifyInstance} from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";
import { flushPreviewWrites,removePreview,setPreview,touchPreview } from "./preview-store.js";
import { indexFileExists,isStaticBuildFresh,planStaticPreview } from "./static-plan.js";
import { ensureProjectDependencies } from "./dependencies.js";
import { runStaticBuild,staticBuildLog } from "./static-build.js";
import { localPreviewOwnerAddress } from "./preview-owner.js";
import { nodeId } from "../nodes/identity.js";
import { setPreviewStartProgress } from "./preview-start-progress.js";
import { readFunctionManifest } from "../functions/manifest.js";
import { startFunctionsPreviewExecutor, type FunctionsPreviewExecutor } from "./functions-preview.js";
import { createHybridListener } from "./hybrid-listener.js";
import { readApiUpstream, type ApiUpstreamConfig } from "./api-upstream.js";
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

export type PreviewModeSetting="auto"|"static"|"container"|"hybrid";
export type StaticBuildSetting="auto"|"always"|"never";

/**
 * `container` keeps the old behaviour, `static` refuses to fall back when a project cannot be
 * served statically (a host that must not run preview containers), and `auto` — the default —
 * serves the build when there is one and uses the dev-server container otherwise.
 */
export function previewModeSetting():PreviewModeSetting{
  const value=(process.env.PREVIEW_MODE??"").trim().toLowerCase();
  return value==="static"||value==="container"||value==="hybrid"?value:"auto";
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
  if(setting==="hybrid")return "hybrid (статика + backend в контейнере, только для проектов с preview.mode=hybrid)";
  return "auto (явный hybrid, иначе статическая сборка; функции — один контейнер на сессию, иначе dev-сервер)";
}

type StaticRun={server:FastifyInstance;dir:string;port:number;log:string;builtAt:number;startedAt:number;/** Files served as they are: nothing was built, so nothing has to be rebuilt. */instant:boolean;/** Конфиг, которым этот предпросмотр поднят: пересборка поднимает тот же каталог заново. */config:SandboxConfig;/** Один контейнер функций на сессию; есть только у проекта с nestdev.functions.json. */functions?:FunctionsPreviewExecutor;/** Сохраняем право тарифа: пересборка не должна поднять контейнер там, где он запрещён. */allowContainer?:boolean;/** Право на functions-preview: оно не зависит от контейнерного preview. */allowFunctions?:boolean;/** Закрывает listener вместе с открытыми соединениями. */close:()=>Promise<void>};

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
export async function startStaticPreview(config:SandboxConfig, options:{allowContainer?:boolean;allowFunctions?:boolean}={}):Promise<StaticStartResult>{
  const plan=await planStaticPreview(config);
  if(!plan.ok)return plan;
  const apiUpstream=await readApiUpstream(config.root);
  if(apiUpstream.kind==="invalid")return {ok:false,reason:apiUpstream.reason};
  let functions;
  try{
    functions=await readFunctionManifest(config.root);
  }catch(error){
    return {ok:false,reason:error instanceof Error?error.message:String(error)};
  }
  // Функции предпросмотра — это отдельный контейнер, но право на него даёт тариф функций, а не
  // контейнерного preview: на «Плюсе» публикация функций разрешена, и их нужно проверять до неё.
  // Без явного права (и без старого `allowContainer`) статика остаётся статикой.
  const allowFunctions=options.allowFunctions??(options.allowContainer!==false);
  const hasFunctions=Boolean(functions?.functions.length)&&allowFunctions;
  const previous=runs.get(config.projectId);
  const build=staticBuildSetting();
  const builtAt=previous?.builtAt??0;
  // An instant site is read from disk on every request, so "fresh" is meaningless for it and
  // a build script does not exist to run: the build flags apply only to projects with a build.
  const fresh=plan.build?await isStaticBuildFresh(config.root,plan.dir,builtAt):true;
  const needsBuild=plan.build&&(build==="always"||(build!=="never"&&!fresh));
  // Функции пересобираются на каждый запуск: иначе правка обработчика не попадёт в уже
  // поднятый runtime. Статическая сборка при этом может остаться свежей.
  const needsFunctions=hasFunctions;

  if(previous&&!needsBuild&&!needsFunctions){
    touchPreview(config.projectId);
    // The listener can outlive a missing registry row (a lost shared write, a stale row from a
    // previous process, or a reset that could not remove it). The listener is the truth here,
    // so restore the row before returning a successful start; otherwise preview.start succeeds
    // and the very next browser.* call says "Preview is not running".
    rememberStaticState(previous);
    // The agent and the panel may land on different API replicas. Flush before returning, just
    // like hybrid and container starts do, so the next browser.* request can hydrate this row.
    await flushPreviewWrites(config.projectId);
    return {ok:true,status:statusFor(previous)};
  }
  if(previous)await stopStaticPreview(config.projectId);

  let log="";
  let marker=previous?.builtAt??0;
  if(needsBuild){
    setPreviewStartProgress(config.projectId,"building","Собираем проект…");
    // Зависимости — до сборки: у только что созданного проекта их нет, и `npm run build` падал
    // бы на отсутствующем `vite`, а предпросмотр — сразу за ним (см. dependencies.ts).
    const dependencies=await ensureProjectDependencies(config);
    if(!dependencies.ok)return {ok:false,reason:dependencies.reason};
    setPreviewStartProgress(config.projectId,"building","Собираем проект…");
    const result=await runStaticBuild(config);
    if(!("ok" in result))return {ok:false,reason:result.reason};
    log=dependencies.log?dependencies.log+"\n"+staticBuildLog(result):staticBuildLog(result);
    marker=Date.now();
  }
  if(!await indexFileExists(plan.dir)){
    return {ok:false,reason:(needsBuild?"сборка не создала ":"нет ")+relative(plan.dir,config.root)+"/index.html"};
  }

  let executor:FunctionsPreviewExecutor|undefined;
  if(hasFunctions&&functions){
    setPreviewStartProgress(config.projectId,"starting","Запускаем один контейнер функций…");
    const started=await startFunctionsPreviewExecutor(config,functions);
    if(!started.ok)return {ok:false,reason:started.reason};
    executor=started.executor;
    log=(log?log+"\n":"")+"Функции: "+functions.functions.length+" в одном контейнере на предпросмотр; /api/* работает без контейнера на запрос.";
  }else if(functions?.functions.length){
    log=(log?log+"\n":"")+"Функции: на текущем тарифе functions-preview недоступен, /api/* в предпросмотре отвечает 404.";
  }
  if(apiUpstream.kind==="configured"){
    log=(log?log+"\n":"")+"API: /api/upstream → "+apiUpstream.config.base+" (same-origin прокси предпросмотра).";
  }
  setPreviewStartProgress(config.projectId,"starting","Запускаем статический сервер…");
  let listener;
  try{
    listener=await listenStatic(plan.dir,executor,apiUpstream.kind==="configured"?apiUpstream.config:undefined);
  }catch(error){
    await executor?.stop().catch(()=>undefined);
    throw error;
  }
  const run:StaticRun={server:listener.app,dir:plan.dir,port:listener.port,log,builtAt:marker,startedAt:Date.now(),instant:!plan.build,config,allowContainer:options.allowContainer,allowFunctions:options.allowFunctions,close:listener.close,...(executor?{functions:executor}:{})};
  runs.set(config.projectId,run);
  // Static слушает только эта реплика, поэтому owner — дверь именно этого процесса. Вторая
  // реплика прочитает строку из общего реестра и проксирует запрос сюда.
  rememberStaticState(run);
  await flushPreviewWrites(config.projectId);
  return {ok:true,status:statusFor(run)};
}

/** Re-persist a local static listener after its registry row was lost. */
function rememberStaticState(run:StaticRun){
  const ownerAddress=localPreviewOwnerAddress();
  setPreview({mode:"static",containerId:"",host:STATIC_HOST,port:run.port,projectId:run.config.projectId,ownerUserId:run.config.userId,node:nodeId(),startedAt:run.startedAt,lastUsedAt:run.startedAt,ready:true,settled:true,...(ownerAddress?{ownerAddress}:{})});
}

/**
 * A live static listener is stronger evidence than a missing registry row. Kept here rather than
 * in preview-manager because the run map is private to this module.
 */
export async function recoverLocalStaticPreview(projectId:string,options:{touch?:boolean}={}):Promise<PreviewStatus|null>{
  const run=runs.get(projectId);
  if(!run||!run.server.server.listening)return null;
  rememberStaticState(run);
  if(options.touch!==false)touchPreview(projectId);
  // Make the recovered row visible to the next API replica before this status returns.
  await flushPreviewWrites(projectId);
  return statusFor(run);
}

export async function stopStaticPreview(projectId:string){
  const run=runs.get(projectId);
  if(!run)return;
  runs.delete(projectId);
  await Promise.all([run.close(),run.functions?.stop().catch(()=>undefined)]);
}

/**
 * Пересборка статического предпросмотра после правки файлов проекта.
 *
 * Палитра из панели правит `theme.css` и ждёт, что цвет появится сразу: у сайта, который
 * отдаётся из каталога сборки, правка исходников сама по себе не видна — нужен новый билд.
 * Готовая статика (без скрипта сборки) читается с диска и пересборки не требует, а контейнерный
 * предпросмотр не трогается: у него свой dev-сервер с горячей перезагрузкой.
 *
 * Возвращает `false`, когда пересобирать было нечего. Неудачная пересборка снимает состояние
 * предпросмотра: кадр, ведущий на закрытый порт, хуже честного «предпросмотр не запущен».
 */
export async function refreshStaticPreview(projectId:string):Promise<boolean>{
  const run=runs.get(projectId);
  if(!run||(run.instant&&!run.functions))return false;
  const result=await startStaticPreview(run.config,{allowContainer:run.allowContainer,allowFunctions:run.allowFunctions});
  if(!result.ok)removePreview(projectId);
  return result.ok;
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
  const functions=run.functions?"\n\nФункции предпросмотра: один постоянный контейнер, /api/* обслуживается без запуска контейнера на запрос.":"";
  const header=run.instant
    ?"Готовая статика: файлы отдаются из "+run.dir+" как есть, сборка не нужна — правки видны сразу после обновления страницы."
    :"Статический предпросмотр: приложение отдаётся из "+run.dir+", горячей перезагрузки нет — обновление после сборки.";
  return (run.log?header+"\n\n"+run.log:header)+functions;
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
  const ownerAddress=localPreviewOwnerAddress();
  // `settled` нужен и в ответе start, а не только в preview/status: для статики ответ сервера —
  // и есть подтверждение адреса. Без него панель считала запуск ещё неподтверждённым и
  // продолжала опрашивать статус, лишний раз перезагружая кадр во время тикета.
  return {running:true,ready:true,settled:true,port:run.port,host:STATIC_HOST,containerId:"",startedAt:run.startedAt,mode:"static",...(run.functions?{hint:"Функции предпросмотра работают: /api/* обслуживает один контейнер на сессию."}:{}),...(ownerAddress?{ownerAddress}:{})};
}

/**
 * A tiny Fastify instance serving the build output, the same way the platform's own frontend
 * is served. An unknown path without a file extension is a client-side route, so index.html is
 * returned; a missing asset keeps its 404 instead of silently becoming HTML.
 */
async function listenStatic(dir:string,functions?:FunctionsPreviewExecutor,apiUpstream?:ApiUpstreamConfig){
  // С функциями или внешним API нужен тот же listener, что у hybrid: статика из процесса API,
  // /api/* в контейнер, а /api/upstream/* — в настроенный проект API. Без них остаётся прежний
  // дешёвый static-сервер.
  if(functions||apiUpstream){
    const listener=await createHybridListener({
      dir,
      backendHost:functions?.host??STATIC_HOST,
      backendPort:functions?.port??0,
      backendPaths:functions?["/api"]:[],
      ...(apiUpstream?{apiUpstream}:{}),
    });
    return {app:listener.app,port:listener.port,close:listener.close};
  }
  const app=Fastify({logger:false,disableRequestLogging:true});
  await app.register(fastifyStatic,{root:dir,index:["index.html"],maxAge:0,cacheControl:true});
  app.setNotFoundHandler((request,reply)=>{
    if(request.method==="GET"||request.method==="HEAD"){
      // Приложение, которому нужен собственный сервер, статически показать нельзя: его запросы к
      // /api отвечали бы index.html, фронтенд разбирал бы HTML как JSON — или падал, или, если он
      // ждёт сессию, рисовал пустой экран. Ошибка выглядела бы как «сломано приложение», хотя дело в
      // отсутствующем API. Поэтому такой путь честно отвечает 404, а не отдаёт страницу.
      if(looksLikeApiPath(request.raw.url??""))return reply.code(404).send({error:"Not Found",detail:"Статический предпросмотр не отвечает на /api: если приложению нужен собственный сервер, запустите его командой запуска (PREVIEW_MODE=container)."});
      if(!looksLikeFile(request.raw.url??""))return reply.sendFile("index.html",{maxAge:0,immutable:false});
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
  return {
    app,
    port,
    close:async()=>{
      // close() waits for connections that are already open, and a browser keeps its sockets
      // alive; the preview must free its port at once, so the leftovers are dropped.
      app.server.closeIdleConnections?.();
      app.server.closeAllConnections?.();
      await app.close().catch(()=>undefined);
    },
  };
}

function looksLikeFile(url:string){
  const pathname=url.split(/[?#]/)[0];
  return /\.[a-z0-9]{1,8}$/i.test(pathname);
}

/** `/api/...` без расширения — это вызов API, а не клиентский маршрут: index.html ему не ответ. */
export function looksLikeApiPath(url:string){
  const pathname=url.split(/[?#]/)[0];
  if(looksLikeFile(pathname))return false;
  return pathname==="/api"||pathname.startsWith("/api/");
}

/** The output directory as the project sees it, for a message the user can act on. */
function relative(dir:string,root:string){
  const value=path.relative(root,dir).replaceAll("\\","/");
  return value&&!value.startsWith(".")?value:dir;
}
