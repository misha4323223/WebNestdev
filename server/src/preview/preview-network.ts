import { readFile } from "node:fs/promises";
import os from "node:os";
import { isIPv4 } from "node:net";
import { dockerExec } from "./docker-exec.js";
import { brokerSelfNetworks } from "../sandbox/docker/endpoint.js";

/**
 * Сеть, в которой живёт сам сервер, — единственный адрес, по которому предпросмотр будет виден
 * серверу, панели и Chromium.
 *
 * В production сервер сам идёт контейнером, а Docker изолирует bridge-сети друг от друга: контейнер
 * предпросмотра, оставшийся в сети по умолчанию, недоступен серверу с другого bridge — при этом
 * `docker exec` внутрь него работает, поэтому предпросмотр выглядит запущенным, а панель показывает
 * белый экран и «Прокси предпросмотра не сработал: fetch failed». Отсюда два правила: сеть берётся
 * из нескольких источников (и отказ не превращается молча в «сеть по умолчанию»), а контейнер
 * предпросмотра при первой же неудаче подключается к сети сервера — `docker network connect`
 * работает и для уже запущенного контейнера.
 *
 * Сети и адреса читаются как JSON, а не как строки шаблона: имя сети в Docker может содержать
 * пробелы и переводы строк, а IPv6-адрес нельзя подставлять в `http://host:port` без скобок.
 */

/** Один шаблон для всех чтений: JSON не зависит от пробелов в именах сетей. */
const NETWORKS_TEMPLATE = "{{json .NetworkSettings.Networks}}";
const NETWORK_CONTAINERS_TEMPLATE = "{{json .Containers}}";

function lines(value:string){
  return value.split("\n").map(line=>line.trim()).filter(Boolean);
}

/** `сеть → IPv4-адрес`; пустая строка — сеть без пригодного адреса. */
function parseNetworkMap(value:string){
  const map=new Map<string,string>();
  let parsed:unknown;
  try{ parsed=JSON.parse(value) }catch{ return map }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return map;
  for(const [name,entry] of Object.entries(parsed as Record<string,unknown>)){
    if(!entry||typeof entry!=="object"||Array.isArray(entry))continue;
    const raw=(entry as {IPAddress?:unknown}).IPAddress;
    const address=typeof raw==="string"?raw.trim():"";
    map.set(name,isIPv4(address)?address:"");
  }
  return map;
}

/** IPv4-адреса контейнеров из `docker network inspect` (CIDR отбрасывается). */
function parseContainerAddresses(value:string){
  const addresses:string[]=[];
  let parsed:unknown;
  try{ parsed=JSON.parse(value) }catch{ return addresses }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return addresses;
  for(const entry of Object.values(parsed as Record<string,unknown>)){
    if(!entry||typeof entry!=="object"||Array.isArray(entry))continue;
    const raw=(entry as {IPv4Address?:unknown}).IPv4Address;
    const address=typeof raw==="string"?raw.split("/")[0]?.trim():"";
    if(address&&isIPv4(address))addresses.push(address);
  }
  return addresses;
}

async function inspectNetworkMap(containerId:string,docker:typeof dockerExec=dockerExec){
  const result=await docker(["inspect","-f",NETWORKS_TEMPLATE,containerId],5000).catch(()=>null);
  if(!result||result.code!==0)return new Map<string,string>();
  return parseNetworkMap(result.stdout);
}

/** Наши собственные имена хоста: переменная и файл могут отличаться, и оба варианта осмысленны. */
async function ownHostnames(){
  const names=[process.env.HOSTNAME?.trim()??""];
  try{ names.push((await readFile("/etc/hostname","utf8")).trim()) }catch{}
  return [...new Set(names.filter(name=>name.length>1))];
}

/** IPv4-адреса самого сервера — по ним его контейнер находится, когда hostname не помогает. */
function ownAddresses(){
  const addresses:string[]=[];
  for(const list of Object.values(os.networkInterfaces()))for(const entry of list??[]){
    if(entry.internal)continue;
    // В Node 18+ family — строка, в старых версиях — число 4. Оставляем оба варианта: иначе
    // fallback по адресам молча не находит ни одной сети.
    const family=entry.family as unknown as string|number;
    if((family==="IPv4"||family===4)&&isIPv4(entry.address))addresses.push(entry.address);
  }
  return [...new Set(addresses)];
}

/**
 * Сети, в которых стоит наш собственный контейнер, найденные по адресам: сервер задаёт свой адрес
 * в каждой сети, и `docker network inspect` перечисляет адреса контейнеров. Так сеть находится
 * даже тогда, когда имя контейнера не совпадает с hostname (свой `hostname:` в compose).
 *
 * Запросы идут параллельно: последовательный обход N сетей с таймаутом 5 с превращался в N×5 с,
 * и найденный список успевал устареть.
 */
async function networksByOwnAddress(docker:typeof dockerExec=dockerExec){
  const addresses=ownAddresses();
  if(!addresses.length)return [];
  const listed=await docker(["network","ls","--format","{{.Name}}"],5000).catch(()=>null);
  if(!listed||listed.code!==0)return [];
  const names=lines(listed.stdout);
  const inspected=await Promise.all(names.map(async name=>{
    const result=await docker(["network","inspect","-f",NETWORK_CONTAINERS_TEMPLATE,name],5000).catch(()=>null);
    return result&&result.code===0?parseContainerAddresses(result.stdout):[];
  }));
  const found:string[]=[];
  for(let index=0;index<names.length;index++){
    if(inspected[index]?.some(address=>addresses.includes(address)))found.push(names[index]);
  }
  return found;
}

/**
 * Сети по hostname. `docker inspect` резолвит не только id, но и имя контейнера, поэтому
 * `HOSTNAME=redis` мог вернуть сети чужого контейнера. Принимаем ответ, только если хотя бы один
 * адрес в нём совпадает с нашим собственным: имя — не доказательство владения.
 */
async function networksByHostname(docker:typeof dockerExec=dockerExec){
  const own=ownAddresses();
  if(!own.length)return [];
  for(const hostname of await ownHostnames()){
    const networks=await inspectNetworkMap(hostname,docker);
    if([...networks.values()].some(address=>address&&own.includes(address))){
      return [...networks.keys()];
    }
  }
  return [];
}

async function discoverServerNetworks(docker:typeof dockerExec=dockerExec):Promise<string[]>{
  // Под брокером `inspect` собственного контейнера запрещён: через него были бы видны метаданные
  // чужих (включая `.Config.Env` базы). Брокер стоит в тех же сетях, что сервер (инвариант compose),
  // поэтому его собственный набор сетей — и есть ответ.
  const viaBroker=await brokerSelfNetworks().catch(()=>null);
  if(viaBroker?.length)return viaBroker;
  const byHostname=await networksByHostname(docker);
  if(byHostname.length)return byHostname;
  return networksByOwnAddress(docker);
}

/**
 * Сети сервера. `PREVIEW_NETWORK` — жёсткое указание оператора, дальше сам контейнер сервера (по
 * имени хоста, затем по адресам). Пустой ответ — это не «сеть по умолчанию», а «сервер не в
 * контейнере»: на хосте предпросмотр на bridge по умолчанию виден напрямую.
 */
export async function serverNetworks(docker:typeof dockerExec=dockerExec):Promise<string[]>{
  const configured=process.env.PREVIEW_NETWORK?.trim();
  if(configured&&!isDatabaseNetwork(configured))return [configured];
  return discoverServerNetworks(docker);
}

/** Сеть базы платформы: предпросмотр к ней подключать нельзя. */
function isDatabaseNetwork(name:string){
  return /(^|[-_])db$/i.test(name);
}

/**
 * Сеть предпросмотра выбирается осознанно: сначала явно заданная, затем сеть с «preview» в имени,
 * и только потом первая попавшаяся — но никогда сеть базы. Иначе `docker network connect` вернул бы
 * пользовательскому коду доступ к postgres, ради изоляции от которого сеть и разделена.
 *
 * Fallback на «первую безопасную» нужен для обычного compose, где сеть сервера называется
 * `src_webnestdev`, а не `…-preview`. Отказ здесь оставил бы предпросмотр на bridge, то есть ровно
 * тот белый экран, ради которого этот модуль и существует.
 */
export function preferPreviewNetwork(names:string[]){
  const safe=names.filter(name=>!isDatabaseNetwork(name));
  return safe.find(name=>/(^|[-_])preview$/i.test(name))??safe[0]??"";
}

export type PreviewNetworks={preview:string;attach:string[]};

/**
 * Один снимок сетей для запуска и подключения. Два независимых вызова `serverNetworks` могли
 * выбрать разные сети, если топология менялась между ними.
 */
export async function previewNetworks(docker:typeof dockerExec=dockerExec):Promise<PreviewNetworks>{
  // `serverNetworks` уже отбрасывает `PREVIEW_NETWORK`, похожий на сеть базы, и в этом случае
  // ищет сети сервера заново. Один снимок используется и для запуска, и для attach.
  const preview=preferPreviewNetwork(await serverNetworks(docker));
  return {preview,attach:preview?[preview]:[]};
}

/** Сеть, на которой запускается контейнер предпросмотра; пусто — подходящей сети нет. */
export async function previewNetwork(docker:typeof dockerExec=dockerExec){
  return (await previewNetworks(docker)).preview;
}

/**
 * Сети, к которым подключается уже запущенный контейнер предпросмотра. Отдельно от `serverNetworks`:
 * сервер стоит и в сети базы, а подключать туда контейнер пользователя нельзя ни при каких
 * обстоятельствах.
 */
export async function previewAttachNetworks(docker:typeof dockerExec=dockerExec){
  return (await previewNetworks(docker)).attach;
}

export async function containerNetworks(containerId:string,docker:typeof dockerExec=dockerExec){
  return [...(await inspectNetworkMap(containerId,docker)).keys()];
}

/** `сеть → адрес` контейнера: адрес нужен тот, который сервер действительно видит. */
async function networkAddresses(containerId:string,docker:typeof dockerExec=dockerExec){
  return inspectNetworkMap(containerId,docker);
}

/** Адрес контейнера в одной из перечисленных сетей — та сторона, с которой его видит сервер. */
export async function addressOnNetworks(containerId:string,networks:string[],docker:typeof dockerExec=dockerExec){
  const addresses=await networkAddresses(containerId,docker);
  for(const network of networks){
    const address=addresses.get(network);
    if(address)return address;
  }
  return "";
}

/** Первый IPv4-адрес контейнера: запасной путь, когда сеть сервера неизвестна. */
export async function firstContainerAddress(containerId:string,docker:typeof dockerExec=dockerExec){
  for(const address of (await inspectNetworkMap(containerId,docker)).values()){
    if(address)return address;
  }
  return "";
}

/** `docker network connect` для уже подключённого контейнера — тоже успех. */
async function connectNetwork(network:string,containerId:string,docker:typeof dockerExec=dockerExec){
  const result=await docker(["network","connect",network,containerId],8000).catch(()=>null);
  if(!result)return false;
  return result.code===0||/already exists/i.test(result.stderr);
}

export type AttachDeps={
  networks?:()=>Promise<string[]>;
  containerNetworks?:(containerId:string)=>Promise<string[]>;
  connect?:(network:string,containerId:string)=>Promise<boolean>;
  addressOnNetworks?:(containerId:string,networks:string[])=>Promise<string>;
  docker?:typeof dockerExec;
};

export type AttachResult={host:string;connected:string[]};

async function doAttach(containerId:string,deps:AttachDeps):Promise<AttachResult>{
  const docker=deps.docker??dockerExec;
  const requested=await (deps.networks??(()=>previewAttachNetworks(docker)))();
  // Даже если вызывающий передал сеть базы, подключать к ней нельзя. Это последний барьер перед
  // Docker: ошибка в источнике списка не должна открывать postgres пользовательскому коду.
  const networks=[...new Set(requested.filter(name=>name.length>0&&!isDatabaseNetwork(name)))];
  if(!networks.length)return {host:"",connected:[]};
  const readNetworks=deps.containerNetworks??((id:string)=>containerNetworks(id,docker));
  const connect=deps.connect??((network:string,id:string)=>connectNetwork(network,id,docker));
  const before=await readNetworks(containerId);
  const beforeSet=new Set(before);
  const attempted=networks.filter(network=>!beforeSet.has(network));
  for(const network of attempted){
    // Результат connect сам по себе не доказательство: под runsc endpoint мог появиться в
    // NetworkSettings, но не в netstack, а ошибка shim — не означать отказа. Настоящий факт —
    // только повторное чтение сетей после подключения.
    await connect(network,containerId).catch(()=>false);
  }
  const after=await readNetworks(containerId);
  const afterSet=new Set(after);
  const connected=attempted.filter(network=>afterSet.has(network));
  const readAddress=deps.addressOnNetworks??((id:string,items:string[])=>addressOnNetworks(id,items,docker));
  let host=await readAddress(containerId,networks);
  // Под runsc inspect может уже показывать endpoint, а netstack ещё не отдаёт адрес. Ждём его
  // ограниченное время, но только после реально появившейся сети: иначе каждый неудачный attach
  // добавлял бы секунды к статусу.
  const networkIsPresent=networks.some(network=>afterSet.has(network));
  if(!host&&networkIsPresent){
    for(let attempt=0;attempt<6&&!host;attempt++){
      await new Promise(resolve=>setTimeout(resolve,250));
      host=await readAddress(containerId,networks);
    }
  }
  return {host,connected};
}

/**
 * Один attach на контейнер за раз. Два параллельных `docker network connect` к одной и той же сети
 * давали ложный отказ (endpoint ещё создавался), после чего второй вызов возвращал пустой host.
 */
const attachLocks=new Map<string,Promise<AttachResult>>();

/**
 * Подключает контейнер предпросмотра к сетям сервера и возвращает адрес, по которому сервер его
 * теперь видит. Контейнер, уже стоящий в нужной сети, не трогается: повторные `docker network
 * connect` не нужны, а чтение адреса нужно ровно затем, чтобы проверять именно доступную сторону.
 */
export function attachToServerNetworks(containerId:string,deps:AttachDeps={}):Promise<AttachResult>{
  const previous=attachLocks.get(containerId);
  const run=(previous?previous.catch(()=>undefined):Promise.resolve())
    .then(()=>doAttach(containerId,deps));
  attachLocks.set(containerId,run);
  const clear=()=>{
    if(attachLocks.get(containerId)===run)attachLocks.delete(containerId);
  };
  run.then(clear,clear);
  return run;
}
