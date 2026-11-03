export const API=import.meta.env.VITE_API_URL??"";

export function apiUrl(path:string){return API+path}

/** Ошибка API сохраняет машинный код: по нему форма входа отличает неподтверждённую почту. */
export class ApiError extends Error{
  constructor(message:string,readonly status:number,readonly code?:string,readonly data?:unknown){
    super(message);
    this.name="ApiError";
  }
}

export async function apiJson<T>(path:string,init?:RequestInit):Promise<T>{
  let response:Response;
  try{
    response=await fetch(apiUrl(path),{...init,credentials:init?.credentials??"include"});
  }catch(error){
    throw new Error("Не удалось подключиться к NestDev API: "+(error instanceof Error?error.message:String(error)));
  }
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new ApiError(data?.error??("HTTP "+response.status),response.status,typeof data?.code==="string"?data.code:undefined,data);
  return data as T;
}
