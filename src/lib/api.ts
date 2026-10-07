export const API=import.meta.env.VITE_API_URL??"";

export function apiUrl(path:string){return API+path}

export async function apiJson<T>(path:string,init?:RequestInit):Promise<T>{
  let response:Response;
  try{
    response=await fetch(apiUrl(path),{...init,credentials:init?.credentials??"include"});
  }catch(error){
    throw new Error("Не удалось подключиться к WebNestdev API: "+(error instanceof Error?error.message:String(error)));
  }
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.error??("HTTP "+response.status));
  return data as T;
}
