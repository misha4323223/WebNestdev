import { useEffect,useState } from "react";
import { CreditCard,Menu,Plus } from "lucide-react";
import { logout } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";
import { getBilling } from "../../lib/billing-api";
import { chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

export function Topbar({projectName,onMenu,onNewProject,onHome,onPlan}:{projectName:string;onMenu:()=>void;onNewProject:()=>void;onHome:()=>void;onPlan:()=>void}){
  const [plan,setPlan]=useState<{name:string;demo:boolean;chosen:string|null}|null>(null);
  const planChoice=usePlanChoice();
  // The workspace shows the active plan and the plan the user selected, so both are
  // visible everywhere instead of only in the billing screens.
  useEffect(()=>{
    let active=true;
    void getBilling()
      .then(data=>{if(!active)return;const current=data.plans.find(item=>item.id===data.subscription.plan);setPlan({name:current?.name??"Бесплатный",demo:data.subscription.status==="demo_active",chosen:isPendingChoice(data,planChoice)?planName(data,chosenPlanId(data,planChoice)):null})})
      .catch(()=>{});
    return ()=>{active=false};
  },[planChoice]);
  return <header className="topbar">
    <button className="icon-button mobile-only" onClick={onMenu} aria-label="Открыть меню"><Menu size={16}/></button>
    <button className="brand brand-home" onClick={onHome} title="На главную"><span className="brand-mark"><WebNestLogo size={16}/></span><span>WebNestdev</span><span className="version">WEB</span></button>
    <div className="topbar-project">{projectName}</div>
    {plan&&<button className="topbar-plan" onClick={onPlan} title={"Тариф: "+plan.name+(plan.demo?" · демо":"")+(plan.chosen?" · выбран "+plan.chosen:"")}><CreditCard size={12}/> {plan.name}{plan.demo?" · демо":""}{plan.chosen&&<span className="topbar-plan-next">→ {plan.chosen}</span>}</button>}
    <div className="topbar-actions">
      <button className="ghost-button" onClick={onNewProject}><Plus size={14}/> Новый проект</button>
      <button className="ghost-button" onClick={async()=>{await logout();window.location.reload()}}>Выйти</button>
    </div>
  </header>;
}
