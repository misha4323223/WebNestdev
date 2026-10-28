import { readFile } from "node:fs/promises";
import os from "node:os";
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
 */

/** Имена сетей контейнера — один шаблон на все три места, где они читаются. */
const NETWORK_NAMES_TEMPLATE = "{{range $name,$value := .NetworkSettings.Networks}}{{$name}}\n{{end}}";
/** Имя сети и адрес в ней: адрес нужен именно тот, который видит сервер. */
const NETWORK_ADDRESSES_TEMPLATE = "{{range $name,$value := .NetworkSettings.Networks}}{{$name}} {{$value.IPAddress}}\n{{end}}";
/** Первый адрес контейнера — запасной путь, когда сетей сервера определить не удалось. */
const FIRST_ADDRESS_TEMPLATE = "{{range .NetworkSettings.Networks}}{{.IPAddress}}\n{{end}}";

function lines(value:string){
  return value.split("\n").map(line=>line.trim()).filter(Boolean);
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
  for(const list of Object.values(os.networkInterfaces()))for(const entry of list??[])if(entry.family==="IPv4"&&!entry.internal)addresses.push(entry.address);
  return addresses;
}

/**
 * Сети, в которых стоит наш собственный контейнер, найденные по адресам: сервер задаёт свой адрес
 * в каждой сети, и `docker network inspect` перечисляет адреса контейнеров. Так сеть находится
 * даже тогда, когда имя контейнера не совпадает с hostname (свой `hostname:` в compose).
 */
async function networksByOwnAddress(){
  const addresses=ownAddresses();
  if(!addresses.length)return [];
  const listed=await dockerExec(["network","ls","--format","{{.Name}}"],5000).catch(()=>null);
  if(!listed||listed.code!==0)return [];
  const found:string[]=[];
  for(const name of lines(listed.stdout)){
    const inspected=await dockerExec(["network","inspect","-f","{{range .Containers}}{{.IPv4Address}}\n{{end}}",name],5000).catch(()=>null);
    if(!inspected||inspected.code!==0)continue;
    if(lines(inspected.stdout).some(value=>addresses.includes(value.split("/")[0])))found.push(name);
  }
  return found;
}

/**
 * Сети сервера. `PREVIEW_NETWORK` — жёсткое указание оператора, дальше сам контейнер сервера (по
 * имени хоста, затем по адресам). Пустой ответ — это не «сеть по умолчанию», а «сервер не в
 * контейнере»: на хосте предпросмотр на bridge по умолчанию виден напрямую.
 */
export async function serverNetworks():Promise<string[]>{
  const configured=process.env.PREVIEW_NETWORK?.trim();
  if(configured)return [configured];
  // Под брокером `inspect` собственного контейнера запрещён: через него были бы видны метаданные
  // чужих (включая `.Config.Env` базы). Брокер стоит в тех же сетях, что сервер (инвариант compose),
  // поэтому его собственный набор сетей — и есть ответ.
  const viaBroker=await brokerSelfNetworks().catch(()=>null);
  if(viaBroker?.length)return viaBroker;
  for(const hostname of await ownHostnames()){
    const result=await dockerExec(["inspect","-f",NETWORK_NAMES_TEMPLATE,hostname],5000).catch(()=>null);
    if(result&&result.code===0){
      const names=lines(result.stdout);
      if(names.length)return names;
    }
  }
  return networksByOwnAddress();
}

/** Сеть базы платформы: предпросмотр к ней подключать нельзя. */
function isDatabaseNetwork(name:string){
  return /(^|[-_])db$/i.test(name);
}

/**
 * Сеть предпросмотра выбирается осознанно: сначала явно заданная, затем сеть с «preview» в имени,
 * и только потом первая попавшаяся — но никогда сеть базы. Иначе `docker network connect` вернул бы
 * пользовательскому коду доступ к postgres, ради изоляции от которого сеть и разделена.
 */
export function preferPreviewNetwork(names:string[]){
  const safe=names.filter(name=>!isDatabaseNetwork(name));
  return safe.find(name=>/(^|[-_])preview$/i.test(name))??safe[0]??"";
}

/** Сеть, на которой запускается контейнер предпросмотра; пусто — подходящей сети нет. */
export async function previewNetwork(){
  return preferPreviewNetwork(await serverNetworks());
}

/**
 * Сети, к которым подключается уже запущенный контейнер предпросмотра. Отдельно от `serverNetworks`:
 * сервер стоит и в сети базы, а подключать туда контейнер пользователя нельзя ни при каких
 * обстоятельствах.
 */
export async function previewAttachNetworks(){
  const configured=process.env.PREVIEW_NETWORK?.trim();
  if(configured)return [configured];
  const networks=await serverNetworks();
  const preferred=preferPreviewNetwork(networks);
  return preferred?[preferred]:[];
}

export async function containerNetworks(containerId:string){
  const result=await dockerExec(["inspect","-f",NETWORK_NAMES_TEMPLATE,containerId],5000).catch(()=>null);
  return result&&result.code===0?lines(result.stdout):[];
}

/** `сеть → адрес` контейнера: адрес нужен тот, который сервер действительно видит. */
async function networkAddresses(containerId:string){
  const result=await dockerExec(["inspect","-f",NETWORK_ADDRESSES_TEMPLATE,containerId],5000).catch(()=>null);
  const map=new Map<string,string>();
  if(!result||result.code!==0)return map;
  for(const line of result.stdout.split("\n")){
    const [name,address]=line.trim().split(/\s+/);
    if(name&&address)map.set(name,address);
  }
  return map;
}

/** Адрес контейнера в одной из перечисленных сетей — та сторона, с которой его видит сервер. */
export async function addressOnNetworks(containerId:string,networks:string[]){
  const addresses=await networkAddresses(containerId);
  for(const network of networks){
    const address=addresses.get(network);
    if(address)return address;
  }
  return "";
}

/** Первый адрес контейнера: запасной путь, когда сеть сервера неизвестна. */
export async function firstContainerAddress(containerId:string){
  const result=await dockerExec(["inspect","-f",FIRST_ADDRESS_TEMPLATE,containerId],5000).catch(()=>null);
  if(!result||result.code!==0)return "";
  return lines(result.stdout)[0]??"";
}

/** `docker network connect` для уже подключённого контейнера — тоже успех. */
async function connectNetwork(network:string,containerId:string){
  const result=await dockerExec(["network","connect",network,containerId],8000).catch(()=>null);
  if(!result)return false;
  return result.code===0||/already exists/i.test(result.stderr);
}

export type AttachDeps={
  networks?:()=>Promise<string[]>;
  containerNetworks?:(containerId:string)=>Promise<string[]>;
  connect?:(network:string,containerId:string)=>Promise<boolean>;
  addressOnNetworks?:(containerId:string,networks:string[])=>Promise<string>;
};

export type AttachResult={host:string;connected:string[]};

/**
 * Подключает контейнер предпросмотра к сетям сервера и возвращает адрес, по которому сервер его
 * теперь видит. Контейнер, уже стоящий в нужной сети, не трогается: повторные `docker network
 * connect` не нужны, а чтение адреса нужно ровно затем, чтобы проверять именно доступную сторону.
 */
export async function attachToServerNetworks(containerId:string,deps:AttachDeps={}):Promise<AttachResult>{
  const networks=await (deps.networks??previewAttachNetworks)();
  if(!networks.length)return {host:"",connected:[]};
  const readNetworks=deps.containerNetworks??containerNetworks;
  const connect=deps.connect??connectNetwork;
  const attached=await readNetworks(containerId);
  const connected:string[]=[];
  for(const network of networks){
    if(attached.includes(network))continue;
    if(await connect(network,containerId))connected.push(network);
  }
  const host=await (deps.addressOnNetworks??addressOnNetworks)(containerId,networks);
  return {host,connected};
}
