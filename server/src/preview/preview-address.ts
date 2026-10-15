import { fetchAppFromContainer, previewAppAnswers } from "./app-http.js";
import { chooseAppPort, listListeningPorts } from "./app-port.js";
import { chooseRelayPort, startContainerRelay } from "./app-relay.js";
import type { PreviewState } from "./types.js";

/**
 * Отвечает ли приложение по адресу, которым пользуются панель (прокси), агент и Chromium.
 * Готовность внутри контейнера (`127.0.0.1`) отвечает на другой вопрос: приложение может быть
 * живым и при этом недоступным снаружи — тогда предпросмотр выглядит работающим, а проверка
 * падает на «fetch failed».
 */
export async function previewAddressAnswers(state:{host:string;port:number},timeoutMs=4_000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    await fetch(`http://${state.host}:${state.port}/`,{redirect:"manual",signal:controller.signal});
    return true;
  }catch{return false}
  finally{clearTimeout(timer)}
}

export type PreviewAddressDeps={
  addressAnswers:(state:{host:string;port:number})=>Promise<boolean>;
  appAnswers:(state:Pick<PreviewState,"containerId"|"port">)=>Promise<boolean>;
  usedPorts:(containerId:string)=>Promise<number[]>;
  startRelay:(input:{containerId:string;targetPort:number;listenPort:number})=>Promise<boolean>;
};

const defaultDeps:PreviewAddressDeps={
  addressAnswers:previewAddressAnswers,
  appAnswers:previewAppAnswers,
  usedPorts:listListeningPorts,
  startRelay:startContainerRelay,
};

/**
 * Доводит адрес предпросмотра до рабочего, потому что приложение решает, где слушать, а не
 * платформа: dev-скрипт может не принять `--host/--port` (тогда настоящий порт берётся из
 * /proc/net/tcp) либо слушать только петлю (тогда внутрь контейнера поднимается проброс).
 * `settled` в состоянии означает, что адрес уже подтверждён: пока он подтверждён, статус не
 * дёргает контейнер на каждый свой вызов. Если починить адрес не удалось, он остаётся
 * неподтверждённым — следующая проверка попробует снова, поэтому медленный первый старт
 * лечится сам.
 */
export async function settlePreviewAddress(state:PreviewState,options:{deps?:PreviewAddressDeps;appAnswers?:boolean}={}):Promise<PreviewState>{
  if(state.mode!=="container"||state.settled)return state;
  const deps=options.deps??defaultDeps;
  if(await deps.addressAnswers(state))return {...state,settled:true};

  const ports=await deps.usedPorts(state.containerId);
  const appPort=chooseAppPort(ports,state.port);
  const current=appPort&&appPort!==state.port?{...state,port:appPort}:state;
  if(current!==state&&await deps.addressAnswers(current))return {...current,settled:true};

  // Приложение, не отвечающее снаружи, но отвечающее внутри, лечится пробросом.
  const appIsUp=options.appAnswers??await deps.appAnswers(current);
  if(!appIsUp)return current;

  const listenPort=chooseRelayPort(ports,state.port);
  if(!listenPort)return current;
  if(!await deps.startRelay({containerId:current.containerId,targetPort:current.port,listenPort}))return current;
  const relayed={...current,port:listenPort};
  return await deps.addressAnswers(relayed)?{...relayed,settled:true}:current;
}

/**
 * Объяснение для агента, когда предпросмотр не отвечает по своему адресу. Проверка изнутри
 * контейнера отличает «приложение живо, но недоступно снаружи» от «приложение не поднялось»:
 * первое лечится перезапуском предпросмотра, второе — правкой проекта.
 */
export function unreachablePreviewDiagnosis(input:{message:string;port:number;appAnswersInside:boolean}){
  return {
    reason:`Unable to reach Preview at port ${input.port}: ${input.message}`,
    hint:input.appAnswersInside
      ? `Приложение отвечает внутри контейнера на порту ${input.port}, но не по адресу контейнера: обычно это значит, что dev-сервер слушает только localhost. Перезапустите предпросмотр (preview.stop, затем preview.start) — платформа сама пробросит порт приложения. Если после перезапуска адрес так и не отвечает, сервер и контейнер предпросмотра живут в разных сетях Docker (PREVIEW_NETWORK).`
      : `Приложение не отвечает и внутри контейнера на порту ${input.port}: dev-сервер не поднялся на этом порту. Посмотрите логи предпросмотра (preview.logs) и команду запуска в package.json.`,
  };
}
