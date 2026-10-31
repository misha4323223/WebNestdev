import { fetchAppFromContainer, findAnsweringPort, previewAppAnswers } from "./app-http.js";
import { chooseAppPort, listListeningPorts, listLoggedPorts } from "./app-port.js";
import { chooseRelayPort, startContainerRelay } from "./app-relay.js";
import { attachToServerNetworks as attachContainerToServerNetworks } from "./preview-network.js";
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
  appAnswers:(state:Pick<PreviewState,"containerId"|"port"|"containerPort">)=>Promise<boolean>;
  usedPorts:(containerId:string)=>Promise<number[]>;
  /** Порты, названные самим приложением в его выводе: источник, которому не нужен `docker exec`. */
  loggedPorts:(containerId:string)=>Promise<number[]>;
  startRelay:(input:{containerId:string;targetPort:number;listenPort:number})=>Promise<boolean>;
  /** Подключает контейнер к сетям сервера и возвращает адрес, видимый с его стороны. */
  attachToServerNetworks:(containerId:string)=>Promise<{host:string;connected:string[]}>;
  /** Порт, на котором приложение отвечает внутри контейнера, — когда таблицы ядра ничего не дали. */
  probePorts:(containerId:string,ports:number[])=>Promise<number|null>;
  /**
   * A private TCP relay on a remote runner. It is opened only after the app answers inside the
   * container; the API cannot route to the runner's Docker bridge, and a raw TCP relay carries
   * both HTTP and HMR WebSockets without publishing a port on the VM.
   */
  openRelay?:(input:{containerId:string;targetPort:number})=>Promise<{host:string;port:number}|null>;
};

const defaultDeps:PreviewAddressDeps={
  addressAnswers:previewAddressAnswers,
  appAnswers:previewAppAnswers,
  usedPorts:listListeningPorts,
  loggedPorts:listLoggedPorts,
  startRelay:startContainerRelay,
  attachToServerNetworks:containerId=>attachContainerToServerNetworks(containerId),
  probePorts:(containerId,ports)=>findAnsweringPort({containerId,ports}),
};

/** Сколько раз и с какой паузой перепроверять адрес после починки. */
export const ADDRESS_CHECK_ATTEMPTS=6;
export const ADDRESS_CHECK_DELAY_MS=400;

/**
 * Порты, которые спрашиваются напрямую, когда таблицы ядра ничего не дали.
 *
 * `/proc/net/tcp` — это один `docker exec` с коротким пределом времени: на занятом хосте он
 * может не уложиться, и тогда приложение, слушающее свой порт (dev-скрипт не принял флаги),
 * оставалось бы на каноническом 3000 навсегда — контейнер жив, а панель белая. Прямой опрос
 * приложения внутри контейнера — второй источник того же факта, и он не зависит от того, успел
 * ли ответить Docker.
 */
export const PROBE_PORTS=[5173,3001,8080,8000,5000];
export type AddressWait={attempts?:number;delayMs?:number};

/**
 * Ждёт, пока адрес начнёт отвечать. Нужно ровно там, где перед проверкой была починка: и
 * `docker network connect`, и запущенный через `docker exec -d` проброс вступают в силу не
 * мгновенно, а одна проверка сразу после них — это ложный вывод «не получилось» и состояние без
 * подтверждённого адреса, из-за которого панель получает белый экран.
 */
async function waitForAddress(state:{host:string;port:number},deps:PreviewAddressDeps,wait:AddressWait={}){
  const attempts=Math.max(1,wait.attempts??ADDRESS_CHECK_ATTEMPTS);
  const delayMs=Math.max(0,wait.delayMs??ADDRESS_CHECK_DELAY_MS);
  for(let attempt=0;attempt<attempts;attempt++){
    if(await deps.addressAnswers(state))return true;
    if(attempt<attempts-1&&delayMs>0)await new Promise(resolve=>setTimeout(resolve,delayMs));
  }
  return false;
}

/**
 * Доводит адрес предпросмотра до рабочего, потому что приложение решает, где слушать, а не
 * платформа: dev-скрипт может не принять `--host/--port` (тогда настоящий порт берётся из
 * /proc/net/tcp) либо слушать только петлю (тогда внутрь контейнера поднимается проброс).
 * `settled` в состоянии означает, что адрес уже подтверждён: пока он подтверждён, статус не
 * дёргает контейнер на каждый свой вызов. Если починить адрес не удалось, он остаётся
 * неподтверждённым — следующая проверка попробует снова, поэтому медленный первый старт
 * лечится сам.
 *
 * Подтверждённый адрес снимает и пометку `execOnly` (панель отдаётся через `docker exec`):
 * подтверждение означает, что до приложения доходит сам сервер, а прямой путь быстрее и отдаёт поток.
 */
export async function settlePreviewAddress(state:PreviewState,options:{deps?:PreviewAddressDeps;appAnswers?:boolean;wait?:AddressWait}={}):Promise<PreviewState>{
  if(state.mode!=="container"||state.settled)return state;
  const deps=options.deps??defaultDeps;
  if(await deps.addressAnswers(state))return {...state,settled:true,execOnly:false};

  const ports=await deps.usedPorts(state.containerId);
  // Пустые таблицы — не приговор: порт берётся из вывода самого дев-сервера (ему не нужен
  // `docker exec`), а затем спрашивается у приложения. Иначе предпросмотр навсегда остаётся на
  // порту, где ничего не слушает (белый кадр при живом контейнере).
  const appPort=chooseAppPort(ports,state.port)??
    chooseAppPort(await deps.loggedPorts(state.containerId),state.port)??
    await deps.probePorts(state.containerId,PROBE_PORTS);
  let current=appPort&&appPort!==state.port?{...state,port:appPort}:state;
  // Порт проверяется и тогда, когда он не изменился: между двумя чтениями статуса мог встать
  // проброс или подключиться нужная сеть, и тогда подтверждать больше нечего.
  if(await deps.addressAnswers(current))return {...current,settled:true,execOnly:false};

  // Адрес молчит — сначала выясняется, живо ли приложение вообще: «не отвечает внутри» и «отвечает,
  // но недоступно снаружи» лечатся по-разному (см. unreachablePreviewDiagnosis).
  // A `false` from the initial readiness wait means "not on the canonical port yet", not
  // "not running": the app may have chosen 5173. Check the discovered port before giving up,
  // otherwise a remote preview would never open its relay.
  const appIsUp=options.appAnswers===true?true:await deps.appAnswers(current);
  if(!appIsUp)return current;

  // Первая починка — сеть: контейнер мог оказаться в сети, которую сервер не видит (Docker
  // изолирует bridge-сети друг от друга, а `docker exec` внутрь работает в любом случае).
  const attached=await deps.attachToServerNetworks(current.containerId).catch(()=>({host:"",connected:[]}));
  if(attached.host&&attached.host!==current.host){
    current={...current,host:attached.host};
    if(await waitForAddress(current,deps,options.wait))return {...current,settled:true,execOnly:false};
  }

  // Вторая — петля: приложение слушает только 127.0.0.1, и проброс поднимается внутрь контейнера.
  let addressState=current;
  const listenPort=chooseRelayPort(ports,state.port);
  if(listenPort){
    if(await deps.startRelay({containerId:current.containerId,targetPort:current.port,listenPort})){
      const relayed={...current,port:listenPort};
      if(await waitForAddress(relayed,deps,options.wait))return {...relayed,settled:true,execOnly:false};
      addressState=relayed;
    }
  }

  // Third — the runner's private TCP relay. On another VM the container address is not
  // routable from the API at all; the relay is the only path that keeps streamed responses and
  // HMR WebSockets. It targets the in-container relay when one was started, otherwise the app
  // port directly. `containerPort` keeps the exec fallback on the app-facing port.
  if(deps.openRelay){
    const relay=await deps.openRelay({containerId:current.containerId,targetPort:addressState.port}).catch(()=>null);
    if(relay){
      const bridged={...current,host:relay.host,port:relay.port,containerPort:addressState.port};
      if(await waitForAddress(bridged,deps,options.wait))return {...bridged,settled:true,execOnly:false};
    }
  }
  return current;
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
      ? `Приложение отвечает внутри контейнера на порту ${input.port}, но не по адресу контейнера: либо dev-сервер слушает только localhost, либо контейнер предпросмотра остался в сети, которой сервер не видит. Перезапустите предпросмотр (preview.stop, затем preview.start) — платформа сама пробросит порт приложения и подключит контейнер к сети сервера. Если адрес так и не отвечает, задайте сеть явно: PREVIEW_NETWORK (docs/PRODUCTION_DEPLOYMENT.md).`
      : `Приложение не отвечает и внутри контейнера на порту ${input.port}: dev-сервер не поднялся на этом порту. Посмотрите логи предпросмотра (preview.logs) и команду запуска в package.json.`,
  };
}
