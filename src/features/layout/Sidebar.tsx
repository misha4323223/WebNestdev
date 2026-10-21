import { useEffect,useState } from "react";
import { Bot,CreditCard,Crown,FolderGit2,History,Home,Terminal } from "lucide-react";
import type { WorkspaceView } from "../workspace/WorkspaceNav";
import { SidebarBanner } from "./SidebarBanner";
import { getBilling } from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

/**
 * Тариф в колонке, над баннером. Раньше капсула стояла в шапке рядом с названием проекта и спорила
 * с ним за место; здесь она рядом с баннером, а смена тарифа открывается тем же путём — настройками.
 */
function SidebarPlan({onPlan}:{onPlan:()=>void}){
  const [plan,setPlan]=useState<{name:string;chosen:string|null}|null>(null);
  const planChoice=usePlanChoice();
  // Действующий тариф приходит с сервера, а выбранный — общее состояние: человек видит и то,
  // что у него есть, и то, на что он собирается перейти, не открывая тарифы.
  useEffect(()=>{
    let active=true;
    void getBilling()
      .then(data=>{if(!active)return;const current=data.plans.find(item=>item.id===activePlanId(data));setPlan({name:current?.name??"Бесплатный",chosen:isPendingChoice(planChoice,data)?planName(data,chosenPlanId(planChoice)):null})})
      .catch(()=>{});
    return ()=>{active=false}
  },[planChoice]);
  if(!plan)return null;
  return <button className={"sidebar-plan"+(plan.chosen?" sidebar-plan-upgrade":"")} onClick={onPlan} title={"Тариф: "+plan.name+(plan.chosen?" · выбран "+plan.chosen:"")}>
    <span className="sidebar-plan-icon"><CreditCard size={12}/></span>
    <span className="sidebar-plan-copy"><small>Тариф</small><strong>{plan.name}</strong></span>
    {plan.chosen&&<span className="sidebar-plan-next"><Crown size={11}/>{plan.chosen}</span>}
  </button>;
}

/**
 * Колонка рабочей области — только навигация. Название проекта, «Секреты» и «Настройки» переехали
 * в шапку: это не разделы работы, а проект, над которым идёт работа, и глобальные действия.
 * Освободившееся место отдано тарифу и витрине.
 */
export function Sidebar({open,view,onView,onPlan,onHome}:{open:boolean;view:WorkspaceView;onView:(view:WorkspaceView)=>void;onPlan:()=>void;onHome:()=>void}){
  return <aside id="workspace-sidebar" className={"sidebar"+(open?" open":"")}>
    <div className="sidebar-section"><button className="nav-item" onClick={onHome}><Home size={14}/> На главную</button></div>
    <div className="sidebar-section"><div className="section-label">РАБОЧАЯ ОБЛАСТЬ</div>
      <button className={"nav-item "+(view==="agent"?"active":"")} onClick={()=>onView("agent")}><Bot size={14}/> Агент</button>
      <button className={"nav-item "+(view==="files"?"active":"")} onClick={()=>onView("files")}><FolderGit2 size={14}/> Файлы</button>
      <button className={"nav-item "+(view==="changes"?"active":"")} onClick={()=>onView("changes")}><History size={14}/> Изменения</button>
      <button className={"nav-item "+(view==="terminal"?"active":"")} onClick={()=>onView("terminal")}><Terminal size={14}/> Терминал</button>
    </div>
    <div className="sidebar-footer">
      <SidebarPlan onPlan={onPlan}/>
      <SidebarBanner/>
    </div>
  </aside>;
}
