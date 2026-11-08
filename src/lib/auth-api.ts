import { apiJson } from "./api";
import type { OnboardingProfile } from "./onboarding";

export type AuthUser={id:string;email:string;phone?:string;createdAt:string;hasPassword?:boolean;yandex?:{login:string;email:string|null};vk?:{name:string;email:string|null}};
/** Контакты знакомства приходят вместе с сессией: null — аккаунт их ещё не оставлял. */
export type AuthState={authenticated:boolean;user:AuthUser|null;onboarding?:{profile:OnboardingProfile|null}};
export type YandexAuthStatus={configured:boolean;callbackUrl:string;loginPath:string};
export type VkAuthStatus={configured:boolean;callbackUrl:string;loginPath:string;scope?:string|null};

export type PhoneStatus={enabled:boolean;provider:string|null;providerLabel:string;configured:boolean;testMode:boolean;sender:string;hint?:string;demoPhone?:string};
export type PhoneStart={sent:boolean;phone:string;provider:string;providerLabel:string;testMode:boolean;expiresInSeconds:number;devCode?:string;notice?:string;demo?:boolean;user?:AuthUser};

export const getAuth=()=>apiJson<AuthState>("/api/auth/me");
export const getYandexAuthStatus=()=>apiJson<YandexAuthStatus>("/api/auth/yandex/status?origin="+encodeURIComponent(window.location.origin));
export const getVkAuthStatus=()=>apiJson<VkAuthStatus>("/api/auth/vk/status?origin="+encodeURIComponent(window.location.origin));
export const getPhoneStatus=()=>apiJson<PhoneStatus>("/api/auth/phone/status");
export const startPhoneLogin=(phone:string,consent:boolean)=>apiJson<PhoneStart>("/api/auth/phone/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,consent})});
export const verifyPhoneLogin=(phone:string,code:string)=>apiJson<{user:AuthUser}>("/api/auth/phone/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({phone,code})});
/** Регистрация по почте завершается письмом, а не сессией: вход появится после перехода по ссылке. */
export type RegisterResult={verificationRequired:true;email:string;expiresInSeconds:number};
export const register=(email:string,password:string)=>apiJson<RegisterResult>("/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const resendVerification=(email:string)=>apiJson<{sent:boolean;retryAfter?:number}>("/api/auth/resend-verification",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})});
/** Ссылка из письма не активирует аккаунт сама: пароль подтверждает, что регистрация своя. */
export const verifyEmail=(token:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/verify-email",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,password})});
/** Письмо восстановления не выдаёт, есть ли такой аккаунт: ответ всегда `sent: true`. */
export const requestPasswordReset=(email:string)=>apiJson<{sent:boolean}>("/api/auth/password-reset/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email})});
/** Ссылка из письма задаёт новый пароль и сразу открывает сессию; старые входы отзываются. */
export const confirmPasswordReset=(token:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/password-reset/confirm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,password})});
/** Смена пароля из настроек: текущий пароль обязателен, остальные сессии завершаются. */
export const changePassword=(currentPassword:string,newPassword:string)=>apiJson<{ok:boolean;revoked:number;signedIn:boolean}>("/api/auth/password/change",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({currentPassword,newPassword})});
export const login=(email:string,password:string)=>apiJson<{user:AuthUser}>("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});
export const logout=()=>apiJson<{ok:boolean}>("/api/auth/logout",{method:"POST"});
/** Отзывает все входы аккаунта, включая текущий: после ответа сессии на этом устройстве тоже нет. */
export const logoutAll=()=>apiJson<{ok:boolean;revoked:number}>("/api/auth/logout-all",{method:"POST"});
