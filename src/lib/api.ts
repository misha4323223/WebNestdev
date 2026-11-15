export const API=import.meta.env.VITE_API_URL??"";

export function apiUrl(path:string){return API+path}

/** Ошибка API сохраняет машинный код: по нему форма входа отличает неподтверждённую почту. */
export class ApiError extends Error{
  constructor(message:string,readonly status:number,readonly code?:string,readonly data?:unknown){
    super(message);
    this.name="ApiError";
  }
}

/**
 * Холодный старт проекта — не ошибка панели. Пока архив распаковывается, любой запрос
 * проекта может получить 409 `PROJECT_RESTORING`; ждём столько, сколько просит сервер
 * (`Retry-After`), и повторяем тот же запрос. Ограничение по времени не даёт вкладке
 * висеть вечно, если восстановление действительно сломалось.
 */
const RESTORE_RETRY_DEFAULT_MS=1_200;
const RESTORE_RETRY_MAX_DELAY_MS=5_000;
const RESTORE_RETRY_WINDOW_MS=120_000;

function retryAfterMs(response:Response,data:unknown,attempt:number){
  const header=response.headers.get("retry-after")?.trim();
  const body=data as {retryAfter?:unknown;retryAfterSeconds?:unknown}|null;
  const hint=header||body?.retryAfter||body?.retryAfterSeconds;
  if(typeof hint==="number"&&Number.isFinite(hint)&&hint>=0)return hint*1000;
  if(typeof hint==="string"&&hint){
    const seconds=Number(hint);
    if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
    const date=Date.parse(hint);
    if(!Number.isNaN(date))return Math.max(0,date-Date.now());
  }
  return Math.min(RESTORE_RETRY_DEFAULT_MS*2**attempt,RESTORE_RETRY_MAX_DELAY_MS);
}

function sleep(ms:number){
  return new Promise<void>(resolve=>window.setTimeout(resolve,ms));
}

export async function apiJson<T>(path:string,init?:RequestInit):Promise<T>{
  const startedAt=Date.now();
  for(let attempt=0;;attempt++){
    let response:Response;
    try{
      response=await fetch(apiUrl(path),{...init,credentials:init?.credentials??"include"});
    }catch(error){
      throw new Error("Не удалось подключиться к NestDev API: "+(error instanceof Error?error.message:String(error)));
    }
    const data=await response.json().catch(()=>null);
    if(response.ok)return data as T;
    const code=typeof data?.code==="string"?data.code:undefined;
    const remaining=RESTORE_RETRY_WINDOW_MS-(Date.now()-startedAt);
    if(response.status===409&&code==="PROJECT_RESTORING"&&remaining>0){
      const delay=Math.min(retryAfterMs(response,data,attempt),remaining);
      if(delay>0){
        await sleep(delay);
        continue;
      }
    }
    throw new ApiError(data?.error??("HTTP "+response.status),response.status,code,data);
  }
}
