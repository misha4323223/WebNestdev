import { dockerExec } from "./docker-exec.js";
import type { DockerExecResult, PreviewState } from "./types.js";

/** Бюджет ответа, который возвращается из контейнера: страницу читают, а не пересылают целиком. */
const DEFAULT_BODY_BYTES=20_000;
/** Внутренний таймаут запроса: подвисший fetch иначе держал бы `docker exec` до его таймаута. */
const DEFAULT_TIMEOUT_MS=5_000;

/**
 * Запрос изнутри контейнера — единственный способ спросить приложение там, где оно действительно
 * слушает. Скрипт печатает один JSON в stdout (статус, тип, тело в base64), поэтому двоичный ответ
 * не ломает разбор, а приложение с петлёй вместо 0.0.0.0 всё равно проверяется.
 */
export function containerFetchScript(input:{url:string;timeoutMs:number;bodyMaxBytes:number}){
  return [
    "const controller=new AbortController();",
    `const timer=setTimeout(()=>{controller.abort();process.exit(2)},${input.timeoutMs});`,
    "timer.unref&&timer.unref();",
    `fetch(${JSON.stringify(input.url)},{redirect:"manual",signal:controller.signal}).then(async response=>{`,
    `const body=Buffer.from(await response.arrayBuffer()).subarray(0,${input.bodyMaxBytes});`,
    'const headers=response.headers.get("content-type");',
    "process.stdout.write(JSON.stringify({status:response.status,statusText:response.statusText,contentType:headers,bytes:body.length,body:body.toString(\"base64\")}));",
    "process.exit(0);",
    "}).catch(error=>{process.stdout.write(JSON.stringify({error:String(error&&error.message||error)}));process.exit(1)});",
  ].join("");
}

export type ContainerAppResponse={status:number;statusText:string;contentType:string|null;body:string;truncated:boolean};

/** Разбор ответа скрипта: последняя непустая строка stdout — единственный JSON, который он печатает. */
export function parseContainerResponse(stdout:string,bodyMaxBytes=DEFAULT_BODY_BYTES){
  const line=stdout.split("\n").map(value=>value.trim()).filter(Boolean).at(-1);
  if(!line)return null;
  let parsed:unknown;
  try{parsed=JSON.parse(line)}catch{return null}
  if(typeof parsed!=="object"||parsed===null)return null;
  const value=parsed as {status?:unknown;statusText?:unknown;contentType?:unknown;bytes?:unknown;body?:unknown};
  if(typeof value.status!=="number"||typeof value.body!=="string")return null;
  const bytes=typeof value.bytes==="number"?value.bytes:Buffer.from(value.body,"base64").length;
  return {
    status:value.status,
    statusText:typeof value.statusText==="string"?value.statusText:"",
    contentType:typeof value.contentType==="string"?value.contentType:null,
    body:Buffer.from(value.body,"base64").toString("utf8"),
    truncated:bytes>=bodyMaxBytes,
  };
}

export type ContainerFetchDeps={docker?:(args:string[],timeoutMs?:number)=>Promise<DockerExecResult>};

/** Ответ приложения на 127.0.0.1:port внутри контейнера; null — если оно не ответило. */
export async function fetchAppFromContainer(input:{containerId:string;port:number;path?:string;timeoutMs?:number;bodyMaxBytes?:number}&ContainerFetchDeps):Promise<ContainerAppResponse|null>{
  const docker=input.docker??dockerExec;
  const timeoutMs=input.timeoutMs??DEFAULT_TIMEOUT_MS;
  const bodyMaxBytes=input.bodyMaxBytes??DEFAULT_BODY_BYTES;
  const path=input.path??"/";
  const script=containerFetchScript({url:`http://127.0.0.1:${input.port}${path}`,timeoutMs,bodyMaxBytes});
  const result=await docker(["exec",input.containerId,"node","-e",script],timeoutMs+3_000).catch(()=>null);
  if(!result||result.code!==0)return null;
  return parseContainerResponse(result.stdout,bodyMaxBytes);
}

/**
 * Готовность приложения: ответ меньше 500 — оно работает (404 у ещё не созданной страницы — тоже
 * ответ, а не отказ). Так же это понимали и раньше, когда проверка жила в preview-runner.
 */
export async function previewAppAnswers(state:Pick<PreviewState,"containerId"|"port">,docker=dockerExec){
  const response=await fetchAppFromContainer({containerId:state.containerId,port:state.port,timeoutMs:8_000,bodyMaxBytes:0,docker});
  return Boolean(response&&response.status<500);
}
