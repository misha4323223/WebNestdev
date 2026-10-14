import { apiJson } from "./api";

export type AuthUser={id:string;email:string;createdAt:string};
export type AuthState={authenticated:boolean;user:AuthUser|null};

export type PhoneStatus={provider:string|null;providerLabel:string;configured:boolean;testMode:boolean;sender:string;hint?:string;demoPhone?:string};
export type PhoneStart={sent:boolean;phone:string;provider:string;providerLabel:string;testMode:boolean;expiresInSeconds:number;devCode?:string;notice?:string;demo?:boolean;user?:AuthUser};

export const getAuth=()=>apiJson<AuthState>("/api/auth/me");
export const getPhoneStatus=()=>apiJson<PhoneStatus>("/api/auth/phone/status");
export const startPhoneLogin=(phone:string,consent:boolean)=>apiJson<PhoneStart>("/api/auth/phone/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,consent})});
export const verifyPhoneLogin=(phone:string,code:string)=>apiJson<{user:AuthUser}>("/api/auth/phone/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,code})});
export const register=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const login=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const logout=()=>apiJson<{ok:boolean}>("/api/auth/logout",{method:"POST"});
