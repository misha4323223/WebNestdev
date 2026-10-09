import { useState, type FormEvent } from "react";
import { login, register, requestPhoneCode, verifyPhoneCode } from "../../lib/auth-api";

export function AuthScreen({onAuthenticated}:{onAuthenticated:()=>void}){
  const [method,setMethod]=useState<"email"|"phone">("phone");
  const [phoneIntent,setPhoneIntent]=useState<"login"|"register">("login");
  const [mode,setMode]=useState<"login"|"register">("login");
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [phone,setPhone]=useState("");
  const [code,setCode]=useState("");
  const [codeRequested,setCodeRequested]=useState(false);
  const [phoneConsent,setPhoneConsent]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);

  async function submit(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    if(method==="phone"&&!phoneConsent){setError("Подтвердите согласие на обработку номера телефона.");return;}
    setBusy(true);
    try{
      if(method==="email"){
        if(mode==="login") await login(email,password);
        else await register(email,password);
        onAuthenticated();
      }else if(!codeRequested){
        const result=await requestPhoneCode(phone,phoneConsent);
        setCodeRequested(true);
        setNotice(result.message);
      }else{
        await verifyPhoneCode(phone,code,phoneIntent);
        onAuthenticated();
      }
    }catch(error){
      const message=error instanceof Error?error.message:"Не удалось выполнить вход";
      if(method==="phone"&&codeRequested&&message.includes("Номер ещё не зарегистрирован")){
        setPhoneIntent("register");setCodeRequested(false);setCode("");setNotice(message);
      }else setError(message);
    }finally{setBusy(false);}
  }

  function switchMethod(next:"email"|"phone"){
    setMethod(next);setError("");setNotice("");setCodeRequested(false);setCode("");setPhoneConsent(false);setPhoneIntent("login");
  }

  return <main className="auth-screen">
    <section className="auth-card">
      <div className="brand auth-brand"><span className="brand-mark">N</span><span>WebNestdev</span><span className="version">WEB</span></div>
      <div className="auth-heading"><span className="eyebrow">ACCOUNT</span><h1>{method==="phone"?(phoneIntent==="login"?"Вход по номеру телефона":"Создание аккаунта по телефону"):mode==="login"?"Вход в WebNestdev":"Создание аккаунта"}</h1><p>{method==="phone"?(phoneIntent==="login"?"Подтвердите номер и войдите. Если аккаунта ещё нет, можно создать его после проверки номера.":"Подтвердите российский номер, чтобы создать аккаунт."):mode==="login"?"Войдите, чтобы открыть рабочую область.":"Создайте аккаунт для локального тестирования полного пользовательского сценария."}</p></div>
      <div className="auth-method-switch">
        <button type="button" className={method==="phone"?"active":""} onClick={()=>switchMethod("phone")}>По телефону</button>
        <button type="button" className={method==="email"?"active":""} onClick={()=>switchMethod("email")}>По email</button>
      </div>
      {method==="phone"&&<div className="auth-method-switch auth-intent-switch">
        <button type="button" disabled={codeRequested} className={phoneIntent==="login"?"active":""} onClick={()=>{setPhoneIntent("login");setError("");setNotice("");}}>Войти</button>
        <button type="button" disabled={codeRequested} className={phoneIntent==="register"?"active":""} onClick={()=>{setPhoneIntent("register");setError("");setNotice("");}}>Создать аккаунт</button>
      </div>}
      <form onSubmit={submit} className="auth-form">
        {method==="email" ? <>
          <label><span>Email</span><input type="email" value={email} onChange={event=>setEmail(event.target.value)} autoComplete="email" required /></label>
          <label><span>Пароль</span><input type="password" value={password} onChange={event=>setPassword(event.target.value)} minLength={8} autoComplete={mode==="login"?"current-password":"new-password"} required /></label>
        </> : <>
          <label><span>Российский номер телефона</span><input type="tel" value={phone} onChange={event=>setPhone(event.target.value)} placeholder="+7 900 123-45-67" autoComplete="tel" required disabled={codeRequested} /></label>
          {codeRequested&&<label><span>Код из SMS</span><input type="text" value={code} onChange={event=>setCode(event.target.value.replace(/\D/g,"").slice(0,6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" required /></label>}
          <label className="auth-phone-consent"><input type="checkbox" checked={phoneConsent} onChange={event=>setPhoneConsent(event.target.checked)}/><span>Согласен на обработку номера телефона для входа, защиты аккаунта и предотвращения повторного получения демо-доступа.</span></label>
        </>}
        {error&&<div className="auth-error">{error}</div>}
        {notice&&<div className="auth-notice">{notice}</div>}
        <button className="send-button auth-submit" disabled={busy}>{busy?"Подождите…":method==="phone"?(codeRequested?(phoneIntent==="register"?"Подтвердить и создать аккаунт":"Подтвердить и войти"):"Получить SMS-код"):mode==="login"?"Войти":"Зарегистрироваться"}</button>
      </form>
      {method==="email"&&<button className="ghost-button auth-switch" onClick={()=>{setMode(mode==="login"?"register":"login");setError("");setNotice("")}}>
        {mode==="login"?"Создать аккаунт":"У меня уже есть аккаунт"}
      </button>}
      {method==="phone"&&codeRequested&&<button type="button" className="ghost-button auth-switch" onClick={()=>{setCodeRequested(false);setCode("");setError("");setNotice("")}}>Изменить номер</button>}
    </section>
  </main>;
}
