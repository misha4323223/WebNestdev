import { useEffect,useState } from "react";
import { Bot,CreditCard,FolderGit2,History,Home,KeyRound,Settings,Sparkles,Terminal } from "lucide-react";
import type { WorkspaceView } from "../workspace/WorkspaceNav";
import { SidebarBanner } from "./SidebarBanner";
import { getBilling } from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

/**
 * Тариф в колонке, над баннером. Раньше капсула стояла в шапке рядом с названием проекта и спорила
 * с ним за место; здесь она рядом с «Настройками» — тем же путём открывается смена тарифа.
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
    {plan.chosen&&<span className="sidebar-plan-next"><Sparkles size={10}/>{plan.chosen}</span>}
  </button>;
}

/**
 * Колонка рабочей области. Создание проекта живёт только на главной странице, а публикация пока
 * спрятана: две кнопки, которые ничего не добавляли к текущей задаче, уводили внимание от работы.
 */
export function Sidebar({open,view,onView,projectName,onSettings,onSecrets,onHome}:{open:boolean;view:WorkspaceView;onView:(view:WorkspaceView)=>void;projectName:string;onSettings:()=>void;onSecrets:()=>void;onHome:()=>void}){
  return <aside className={"sidebar"+(open?" open":"")}>
    <div className="sidebar-section"><button className="nav-item" onClick={onHome}><Home size={14}/> На главную</button></div>
    <div className="sidebar-section"><div className="section-label">РАБОЧАЯ ОБЛАСТЬ</div>
      <button className={"nav-item "+(view==="agent"?"active":"")} onClick={()=>onView("agent")}><Bot size={14}/> Агент</button>
      <button className={"nav-item "+(view==="files"?"active":"")} onClick={()=>onView("files")}><FolderGit2 size={14}/> Файлы</button>
      <button className={"nav-item "+(view==="changes"?"active":"")} onClick={()=>onView("changes")}><History size={14}/> Изменения</button>
      <button className={"nav-item "+(view==="terminal"?"active":"")} onClick={()=>onView("terminal")}><Terminal size={14}/> Терминал</button>
      <button className="nav-item" onClick={onSecrets}><KeyRound size={14}/> Секреты</button>
    </div>
    <div className="sidebar-section"><div className="section-label">ПРОЕКТ</div><div className="project-row"><span className="status-dot"/>{projectName}</div></div>
    <div className="sidebar-footer">
      <SidebarPlan onPlan={onSettings}/>
      <SidebarBanner/>
      <button className="nav-item" onClick={onSettings}><Settings size={14}/> Настройки</button>
    </div>
  </aside>;
}
