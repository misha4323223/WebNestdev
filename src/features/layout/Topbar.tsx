import { useEffect,useState } from "react";
import { CreditCard,Menu,Monitor,Plus } from "lucide-react";
import { logout } from "../../lib/auth-api";
import { WebNestLogo } from "../../components/WebNestLogo";
import { getBilling } from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

export function Topbar({projectName,onMenu,onNewProject,onHome,onPlan,previewOpen,previewRunning,onPreviewToggle}:{projectName:string;onMenu:()=>void;onNewProject:()=>void;onHome:()=>void;onPlan:()=>void;previewOpen:boolean;previewRunning:boolean;onPreviewToggle:()=>void}){
  const [plan,setPlan]=useState<{name:string;chosen:string|null}|null>(null);
  const planChoice=usePlanChoice();
  // The workspace shows the active plan and the plan the user selected, so both are
  // visible everywhere instead of only in the billing screens.
  useEffect(()=>{
    let active=true;
    void getBilling()
      .then(data=>{if(!active)return;const current=data.plans.find(item=>item.id===activePlanId());setPlan({name:current?.name??"Бесплатный",chosen:isPendingChoice(planChoice)?planName(data,chosenPlanId(planChoice)):null})})
      .catch(()=>{});
    return ()=>{active=false};
  },[planChoice]);
  return <header className="topbar">
    <button className="icon-button mobile-only" onClick={onMenu} aria-label="Открыть меню"><Menu size={16}/></button>
    <button className="brand brand-home" onClick={onHome} title="На главную"><span className="brand-mark"><WebNestLogo size={22} tone="light"/></span><span>WebNestdev</span><span className="version">WEB</span></button>
    <div className="topbar-project">{projectName}</div>
    {plan&&<button className="topbar-plan" onClick={onPlan} title={"Тариф: "+plan.name+(plan.chosen?" · выбран "+plan.chosen:"")}><CreditCard size={12}/> {plan.name}{plan.chosen&&<span className="topbar-plan-next">→ {plan.chosen}</span>}</button>}
    <div className="topbar-actions">
      {/* Only on a phone, where the preview is a drawer and needs a way in and out. */}
      <button className={"icon-button preview-toggle"+(previewOpen?" active":"")} onClick={onPreviewToggle} aria-expanded={previewOpen} aria-controls="preview-panel" aria-label="Предпросмотр проекта" title="Предпросмотр проекта">
        <Monitor size={16}/>
        {previewRunning&&<span className="preview-toggle-dot" aria-hidden="true"/>}
      </button>
      <button className="ghost-button" onClick={onNewProject}><Plus size={14}/> Новый проект</button>
      <button className="ghost-button" onClick={async()=>{await logout();window.location.reload()}}>Выйти</button>
    </div>
  </header>;
}
