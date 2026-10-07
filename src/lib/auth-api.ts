import { apiJson } from "./api";

export type AuthUser={id:string;email:string;createdAt:string};
export type AuthState={authenticated:boolean;user:AuthUser|null};

export const getAuth=()=>apiJson<AuthState>("/api/auth/me");
export const register=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const login=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const logout=()=>apiJson<{ok:boolean}>("/api/auth/logout",{method:"POST"});
