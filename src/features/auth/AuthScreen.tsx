import { useState } from "react";
import type { FormEvent } from "react";
import { login,register } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";

export function AuthScreen({onAuthenticated}:{onAuthenticated:()=>void}){
  const [mode,setMode]=useState<"login"|"register">("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);

  async function submit(event:FormEvent){
    event.preventDefault();
    setError("");
    setBusy(true);
    try{
      if(mode==="login") await login(email,password);
      else await register(email,password);
      onAuthenticated();
    }catch(error){
      setError(error instanceof Error?error.message:"Не удалось выполнить вход");
    }finally{setBusy(false);}
  }

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="auth-logo"><WebNestLogo size={42}/><div className="brand"><span>WebNestdev</span><span className="version">WEB</span></div></div>
      <div className="auth-heading"><span className="eyebrow">ACCOUNT</span><h1>{mode==="login"?"Вход в WebNestdev":"Создание аккаунта"}</h1><p>{mode==="login"?"Войдите, чтобы открыть рабочую область.":"Создайте аккаунт для локального тестирования полного пользовательского сценария."}</p></div>
      <form onSubmit={submit} className="auth-form">
        <label><span>Email</span><input type="email" value={email} onChange={event=>setEmail(event.target.value)} autoComplete="email" required /></label>
        <label><span>Пароль</span><input type="password" value={password} onChange={event=>setPassword(event.target.value)} minLength={8} autoComplete={mode==="login"?"current-password":"new-password"} required /></label>
        {error&&<div className="auth-error">{error}</div>}
        <button className="send-button auth-submit" disabled={busy}>{busy?"Подождите…":mode==="login"?"Войти":"Зарегистрироваться"}</button>
      </form>
      <button className="ghost-button auth-switch" onClick={()=>{setMode(mode==="login"?"register":"login");setError("")}}>
        {mode==="login"?"Создать аккаунт":"У меня уже есть аккаунт"}
      </button>
    </section>
  </main>;
}