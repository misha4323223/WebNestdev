import { apiJson } from "./api";

export type AuthUser={id:string;email:string;phone?:string|null;createdAt:string};
export type AuthState={authenticated:boolean;user:AuthUser|null};

export const getAuth=()=>apiJson<AuthState>("/api/auth/me");
export const register=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const login=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const requestPhoneCode=(phone:string,consent:boolean)=>apiJson<{ok:boolean;resendAfter:string;message:string}>("/api/auth/phone/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,consent})});
export const verifyPhoneCode=(phone:string,code:string,intent:"login"|"register"="login")=>apiJson<{user:AuthUser}>("/api/auth/phone/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,code,intent})});
export const requestPhoneLinkCode=(phone:string,consent:boolean)=>apiJson<{ok:boolean;resendAfter:string;message:string}>("/api/auth/phone/link/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,consent})});
export const verifyPhoneLinkCode=(phone:string,code:string)=>apiJson<{ok:boolean;phone:string}>("/api/auth/phone/link/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,code})});
export const logout=()=>apiJson<{ok:boolean}>("/api/auth/logout",{method:"POST"});
