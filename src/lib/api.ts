export const API=import.meta.env.VITE_API_URL??"";

export function apiUrl(path:string){return API+path}

export async function apiJson<T>(path:string,init?:RequestInit):Promise<T>{
  const response=await fetch(apiUrl(path),init);
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.error??("HTTP "+response.status));
  return data as T;
}
