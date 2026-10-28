import { dockerExec } from "./docker-exec.js";
import { PREVIEW_APP_PORT } from "./types.js";

/**
 * Порты, которые слушают внутри контейнера, — из таблиц ядра (/proc/net/tcp и /proc/net/tcp6).
 * Это факт о приложении, а не предположение о том, что dev-скрипт проекта понял флаги
 * `--host 0.0.0.0 --port 3000`. Скрипт вида `concurrently "vite" "node server.js"` эти флаги
 * не принимает, и приложение остаётся на своём порту — тогда платформа стучалась бы в пустой 3000
 * и считала бы живой предпросмотр сломанным.
 */
export function parseListeningPorts(tables:string){
  const ports=new Set<number>();
  for(const line of tables.split("\n")){
    const fields=line.trim().split(/\s+/);
    // sl local_address rem_address st ...; "0A" в поле st — LISTEN.
    if(fields.length<4||fields[3]!=="0A")continue;
    const port=Number.parseInt(fields[1]?.split(":")[1]??"",16);
    if(Number.isInteger(port)&&port>0&&port<65536)ports.add(port);
  }
  return [...ports].sort((a,b)=>a-b);
}

/** Порты, на которые смотрит сервер предпросмотра; порядок — от частого к редкому. */
const COMMON_APP_PORTS=[PREVIEW_APP_PORT,5173,3001,8080,8000,5000,4000,4200,4321];
/** А это порты сервисов, которые dev-скрипт поднимает рядом: postgres, redis и подобные. */
const SERVICE_PORTS=new Set([3306,5432,6379,9200,9092,27017]);

/**
 * Канонический порт, если приложение на нём; иначе знакомый инструментам; иначе младший
 * прикладной. Выбор не зависит от порядка, в котором таблицы ядра вернули порты.
 */
export function chooseAppPort(ports:number[],preferred=PREVIEW_APP_PORT){
  if(ports.includes(preferred))return preferred;
  for(const port of COMMON_APP_PORTS)if(ports.includes(port))return port;
  const usable=ports.filter(port=>port>1024&&!SERVICE_PORTS.has(port));
  return usable.length?Math.min(...usable):null;
}

export async function listListeningPorts(containerId:string,docker=dockerExec){
  const result=await docker(["exec",containerId,"sh","-c","cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"],8000).catch(()=>null);
  if(!result||result.code!==0)return [];
  return parseListeningPorts(result.stdout);
}

/**
 * Порты, которые дев-сервер сам назвал в своём выводе.
 *
 * Vite, Astro, SvelteKit, Next и Nuxt печатают адрес, на котором слушают: «Local: http://localhost:5173/».
 * Это третий источник порта наравне с таблицами ядра и опросом внутри контейнера, и единственный,
 * которому не нужен `docker exec`: `docker logs` работает всегда. Именно поэтому он спасает
 * предпросмотр, когда exec недоступен (а без порта платформа навсегда остаётся на каноническом 3000:
 * контейнер жив, приложение работает, панель белая).
 *
 * В чужие строки не лезем: берутся только строки с адресом, иначе чисел с двоеточием в выводе
 * хватает (тайминги, версии). Выбор из найденного — тот же `chooseAppPort`, поэтому служебные порты
 * и порт API вроде 8787 не перебивают 3000/5173.
 */
export function parseLoggedPorts(logs:string){
  const ports=new Set<number>();
  // Вывод дев-сервера идёт с ANSI-кодами, и цвет часто стоит прямо перед номером порта:
  // `http://localhost:\u001b[1m5173\u001b[22m`. Без снятия цветов `:5173` не находится.
  const plain=logs.replace(/\u001b\[[0-9;]*[A-Za-z]/g,"");
  for(const line of plain.split("\n")){
    if(!/(https?:\/\/|local\b|network\b|listening|running at|started server)/i.test(line))continue;
    for(const match of line.matchAll(/:(\d{2,5})(?!\d)/g)){
      const port=Number.parseInt(match[1],10);
      if(Number.isInteger(port)&&port>0&&port<65536)ports.add(port);
    }
  }
  return [...ports].sort((a,b)=>a-b);
}

/** Те же порты, но из вывода самого контейнера — без `docker exec`. */
export async function listLoggedPorts(containerId:string,docker=dockerExec){
  const result=await docker(["logs","--tail","200",containerId],8000).catch(()=>null);
  if(!result||result.code!==0)return [];
  return parseLoggedPorts(result.stdout+"\n"+result.stderr);
}

export async function discoverAppPort(containerId:string,preferred=PREVIEW_APP_PORT,docker=dockerExec){
  return chooseAppPort(await listListeningPorts(containerId,docker),preferred);
}
