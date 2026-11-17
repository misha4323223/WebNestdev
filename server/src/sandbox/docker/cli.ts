import { spawn } from "node:child_process";
import { dockerUnavailableMessage } from "./unavailable.js";
import type { DockerCliResult } from "./types.js";

/**
 * Сообщение о таймауте Docker CLI. Печатается только подкоманда: аргументы содержат пути и
 * текст команды, а имя субкоманды — нет.
 */
export function dockerTimeoutMessage(args:string[],timeoutMs:number){
  const subcommand=args[0]??"docker";
  return `Превышено время ожидания операции Docker (${subcommand}, ${Math.round(timeoutMs/1000)} с)`;
}

/**
 * One Docker CLI call. Before the remote runner exists this is the only place in the platform
 * that spawns `docker` for previews and jobs: the local `SandboxHost` calls it, and a remote
 * host will implement the same operation against its own node instead of the local socket.
 */
export function runDockerCli(args:string[],timeoutMs=15000,input?:string|Buffer):Promise<DockerCliResult>{
  return new Promise((resolve,reject)=>{
    const child=spawn("docker",args,{stdio:[input===undefined?"ignore":"pipe","pipe","pipe"],windowsHide:true});
    if(input!==undefined&&child.stdin){
      // stdin нужен серверless-исполнителю: тело запроса не должно попадать в argv или env.
      // Контейнер может закрыть поток раньше (ошибка запуска) — это не повод ронять API
      // необработанным EPIPE: результат всё равно придёт в stderr и коде выхода.
      child.stdin.on("error",()=>undefined);
      child.stdin.end(input);
    }
    let stdout="",stderr="";
    const timer=setTimeout(()=>{child.kill("SIGKILL");reject(new Error(dockerTimeoutMessage(args,timeoutMs)))},timeoutMs);
    // Отказ запуска процесса — это не ответ контейнера, а отсутствие Docker на хосте: причина
    // должна доехать до панели предпросмотра и до модели в понятном виде, а не как `spawn ENOENT`.
    child.once("error",error=>{clearTimeout(timer);reject(new Error(dockerUnavailableMessage(error)))});
    child.once("close",code=>{clearTimeout(timer);resolve({code:code??1,stdout,stderr})});
    child.stdout?.on("data",(chunk:Buffer)=>stdout+=chunk.toString());
    child.stderr?.on("data",(chunk:Buffer)=>stderr+=chunk.toString());
  });
}
