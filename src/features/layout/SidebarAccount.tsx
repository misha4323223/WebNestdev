import { useEffect,useRef,useState } from "react";
import { ChevronDown,KeyRound,LogOut,Settings,UserRound } from "lucide-react";
import { getAuth,logout,type AuthState } from "../../lib/auth-api";
import { contactEmailOf } from "../../lib/account-contact";

/**
 * Подпись аккаунта в колонке: имя из знакомства, а второй строкой — почта для связи или телефон.
 * Служебный адрес входа (79990000000@phone.webnestdev.local) не показывается: номер выводится
 * привычными группами, почта берётся из контактов или настоящего адреса аккаунта.
 */
function accountLabel(state:AuthState|null){
  const profile=state?.onboarding?.profile;
  const email=contactEmailOf({
    profileEmail:profile?.email,
    accountEmail:state?.user?.email,
    yandexEmail:state?.user?.yandex?.email,
  });
  const raw=state?.user?.email?.trim()??"";
  const [local,domain]=raw.split("@");
  const phone=state?.user?.phone?.trim()
    ||(domain&&domain.startsWith("phone.")&&/^\d{11}$/.test(local)
      ?"+"+local[0]+" "+local.slice(1,4)+" "+local.slice(4,7)+"-"+local.slice(7,9)+"-"+local.slice(9,11)
      :"");
  const name=profile?.name?.trim()||phone||(email?email.split("@")[0]:"");
  if(!name)return {name:"Аккаунт",detail:"вход выполнен"};
  return {name,detail:email||phone||"вход выполнен"};
}

/**
 * Аккаунт внизу колонки, под тарифом и поддержкой. В шапке он занимал место рядом с веткой
 * и предпросмотром, а здесь это последняя строка рабочей области: настройки и выход всегда
 * под рукой, но не спорят за ширину с действиями над проектом.
 *
 * Меню раскрывается вверх: внизу колонки нет места под ним, а прокручиваемый список чатов
 * остаётся выше и не уезжает вместе с меню.
 */
export function SidebarAccount({onSettings,onSecrets}:{onSettings:()=>void;onSecrets:()=>void}){
  const [open,setOpen]=useState(false);
  const [auth,setAuth]=useState<AuthState|null>(null);
  const rootRef=useRef<HTMLDivElement|null>(null);

  useEffect(()=>{
    let active=true;
    void getAuth().then(state=>{if(active)setAuth(state)}).catch(()=>{});
    return ()=>{active=false}
  },[]);

  useEffect(()=>{
    if(!open)return;
    const onPointer=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target&&rootRef.current?.contains(target))return;
      setOpen(false);
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false)};
    document.addEventListener("pointerdown",onPointer,true);
    window.addEventListener("keydown",onKey);
    return ()=>{
      document.removeEventListener("pointerdown",onPointer,true);
      window.removeEventListener("keydown",onKey);
    };
  },[open]);

  const account=accountLabel(auth);
  return <div className="sidebar-account" ref={rootRef}>
    <button
      type="button"
      className={"sidebar-account-button"+(open?" open":"")}
      onClick={()=>setOpen(value=>!value)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls="sidebar-account-menu"
      title={"Аккаунт: "+account.name+" — настройки и выход"}
    >
      <span className="sidebar-account-avatar"><UserRound size={15}/></span>
      <span className="sidebar-account-copy"><strong>{account.name}</strong><small>{account.detail}</small></span>
      <ChevronDown size={12} className={"sidebar-account-caret"+(open?" open":"")}/>
    </button>
    {open&&<div className="sidebar-account-menu" id="sidebar-account-menu" role="menu" aria-label="Аккаунт">
      <span className="topbar-menu-label">АККАУНТ</span>
      <div className="topbar-account-head">
        <span className="topbar-account-mark"><UserRound size={14}/></span>
        <div><strong>{account.name}</strong><small>{account.detail}</small></div>
      </div>
      <button role="menuitem" className="topbar-menu-item" onClick={()=>{setOpen(false);onSettings()}}>
        <span className="topbar-menu-name">Настройки и тариф</span><Settings size={13}/>
      </button>
      <button role="menuitem" className="topbar-menu-item" onClick={()=>{setOpen(false);onSecrets()}}>
        <span className="topbar-menu-name">Секреты проекта</span><KeyRound size={13}/>
      </button>
      <div className="topbar-menu-foot">
        <button role="menuitem" className="topbar-menu-item danger" onClick={async()=>{await logout();window.location.reload()}}>
          <span className="topbar-menu-name">Выйти</span><LogOut size={13}/>
        </button>
      </div>
    </div>}
  </div>;
}
