import { dockerExec } from "./docker-exec.js";
import { PREVIEW_APP_PORT } from "./types.js";

/**
 * Приложение, слушающее только 127.0.0.1 внутри контейнера, недоступно по адресу контейнера:
 * `docker exec` его видит, а сервер, панель и Chromium — нет, и проверка падает на «fetch failed»,
 * хотя dev-сервер жив. Такому приложению внутрь контейнера поднимается проброс: он слушает
 * 0.0.0.0 на порту платформы и передаёт соединения на петлю приложения. Проброс — на уровне TCP,
 * поэтому через него идут и обычные запросы, и HMR-websocket.
 */
export function relayScript(targetPort:number,listenPort:number){
  return [
    'const net=require("node:net");',
    `const server=net.createServer(client=>{const upstream=net.connect(${targetPort},"127.0.0.1");`,
    'const stop=()=>{client.destroy();upstream.destroy()};',
    'client.on("error",stop);upstream.on("error",stop);',
    "client.pipe(upstream);upstream.pipe(client);});",
    `server.listen(${listenPort},"0.0.0.0");`,
  ].join("");
}

/** Порт проброса: канонический, если его не заняло приложение, иначе первый следующий за ним. */
export function chooseRelayPort(used:number[],preferred=PREVIEW_APP_PORT){
  const taken=new Set(used);
  for(let port=preferred;port<preferred+10;port++)if(!taken.has(port))return port;
  return null;
}

/**
 * `docker exec -d` возвращается сразу, поэтому занятый порт здесь не виден — успех проброса
 * подтверждает вызывающий, пробуя адрес контейнера после запуска.
 */
export async function startContainerRelay(input:{containerId:string;targetPort:number;listenPort:number;docker?:typeof dockerExec}){
  const docker=input.docker??dockerExec;
  const result=await docker(["exec","-d",input.containerId,"node","-e",relayScript(input.targetPort,input.listenPort)],8000).catch(()=>null);
  return Boolean(result&&result.code===0);
}
