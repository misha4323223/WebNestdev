import { spawn } from "node:child_process";
import { dockerUnavailableMessage } from "../sandbox/docker/unavailable.js";
import type { DockerExecResult } from "./types.js";

/**
 * Контейнера, о котором помнит сервер, больше нет: его удалили извне, хост перезапустил Docker или
 * (пока предпросмотр запускался с `--rm`) его унёс сам Docker после выхода процесса. Ответ Docker
 * приходит по-английски (`Error response from daemon: No such container: <id>`) и не должен ни
 * попадать пользователю как текст ошибки запуска, ни оседать в логах приложения.
 */
export function missingContainer(result: DockerExecResult) {
  return result.code !== 0 && /no such container|no such object/i.test(result.stderr);
}

/**
 * Что именно не ответило — в самом сообщении об ошибке.
 *
 * «Превышено время ожидания операции Docker» одинаково описывало и зависший `run`, и `inspect`, и
 * `exec`, поэтому по журналу нельзя было понять, где остановился Docker CLI. Печатается только
 * подкоманда: аргументы содержат пути и текст команды, а имя субкоманды — нет.
 */
export function dockerTimeoutMessage(args:string[],timeoutMs:number){
  const subcommand=args[0]??"docker";
  return `Превышено время ожидания операции Docker (${subcommand}, ${Math.round(timeoutMs/1000)} с)`;
}

export function dockerExec(args:string[],timeoutMs=15000):Promise<DockerExecResult>{
  return new Promise((resolve,reject)=>{
    const process=spawn("docker",args,{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="";
    process.stdout.on("data",(x:Buffer)=>stdout+=x.toString());
    process.stderr.on("data",(x:Buffer)=>stderr+=x.toString());
    const timer=setTimeout(()=>{process.kill("SIGKILL");reject(new Error(dockerTimeoutMessage(args,timeoutMs)))},timeoutMs);
    // Отказ запуска процесса — это не ответ контейнера, а отсутствие Docker на хосте: причина
    // должна доехать до панели предпросмотра и до модели в понятном виде, а не как `spawn ENOENT`.
    process.once("error",error=>{clearTimeout(timer);reject(new Error(dockerUnavailableMessage(error)))});
    process.once("close",code=>{clearTimeout(timer);resolve({code:code??1,stdout,stderr})});
  });
}
