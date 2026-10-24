import { useEffect,useState } from "react";
import { Bot,CreditCard,Crown,FolderGit2,HardDrive,History,Home,Terminal } from "lucide-react";
import type { WorkspaceView } from "../workspace/WorkspaceNav";
import { SidebarBanner } from "./SidebarBanner";
import { bytesLabel, getBilling } from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";

/**
 * Тариф в колонке, над баннером. Раньше капсула стояла в шапке рядом с названием проекта и спорила
 * с ним за место; здесь она рядом с баннером, а смена тарифа открывается тем же путём — настройками.
 */
type SidebarPlanInfo={name:string;chosen:string|null;planId:string;used:number;limit:number;storageUsed:number;storageLimit:number};

/**
 * Полоска бесплатных шагов. Шаги — это запуски агента на встроенной модели, поэтому именно они,
 * а не отдельные инструменты внутри запуска, показывают, сколько бесплатного осталось.
 * Цвет — состояние, а не украшение: спокойный зелёный, оранжевый на половине и красный к концу.
 */
function freeStepsState(used:number,limit:number){
  if(limit<=0)return "calm";
  const ratio=used/limit;
  if(ratio>=0.8)return "danger";
  if(ratio>=0.5)return "warn";
  return "calm";
}

function SidebarPlan({onPlan}:{onPlan:()=>void}){
  const [plan,setPlan]=useState<SidebarPlanInfo|null>(null);
  const planChoice=usePlanChoice();
  // Действующий тариф приходит с сервера, а выбранный — общее состояние: человек видит и то,
  // что у него есть, и то, на что он собирается перейти, не открывая тарифы. Расход обновляется
  // при возврате на вкладку: запуск агента заканчивается, пока человек смотрит на результат.
  useEffect(()=>{
    let active=true;
    const load=()=>void getBilling()
      .then(data=>{
        if(!active)return;
        const current=data.plans.find(item=>item.id===activePlanId(data));
        setPlan({
          name:current?.name??"Старт",
          chosen:isPendingChoice(planChoice,data)?planName(data,chosenPlanId(planChoice)):null,
          planId:activePlanId(data),
          used:data.usage.agentRuns,
          limit:data.limits.agentRunsPerDay,
          storageUsed:data.storage?.usedBytes ?? 0,
          storageLimit:data.limits.storageBytes ?? 0,
        });
      })
      .catch(()=>{});
    load();
    window.addEventListener("focus",load);
    return ()=>{active=false;window.removeEventListener("focus",load)}
  },[planChoice]);
  if(!plan)return null;
  const free=plan.planId==="free"&&plan.limit>0;
  const state=freeStepsState(plan.used,plan.limit);
  const left=Math.max(0,plan.limit-plan.used);
  // Хранилище показывается только когда оно близко к концу: в спокойном состоянии это
  // лишняя строка, а на 80% и 100% — новость, которую нельзя пропустить.
  const storageRatio=plan.storageLimit>0?plan.storageUsed/plan.storageLimit:0;
  const storageState=storageRatio>=1?"full":storageRatio>=0.8?"warn":"";
  return <>
    <button className={"sidebar-plan"+(plan.chosen?" sidebar-plan-upgrade":"")} onClick={onPlan} title={"Тариф: "+plan.name+(plan.chosen?" · выбран "+plan.chosen:"")}>
      <span className="sidebar-plan-icon"><CreditCard size={12}/></span>
      <span className="sidebar-plan-copy"><small>Тариф</small><strong>{plan.name}</strong></span>
      {plan.chosen&&<span className="sidebar-plan-next"><Crown size={11}/>{plan.chosen}</span>}
    </button>
    {free&&<div className={"sidebar-steps "+state} title={left>0?"Осталось "+left+" бесплатных запусков агента сегодня":"Бесплатные запуски на сегодня закончились"}>
      <div className="sidebar-steps-head"><span>Бесплатные шаги</span><strong>{plan.used} / {plan.limit}</strong></div>
      <div className="sidebar-steps-track" role="progressbar" aria-valuemin={0} aria-valuemax={plan.limit} aria-valuenow={plan.used} aria-label="Бесплатные шаги агента">
        <span style={{width:Math.max(4,Math.min(100,plan.used/Math.max(1,plan.limit)*100))+"%"}}/>
      </div>
    </div>}
    {storageState&&<button className={"sidebar-storage "+storageState} onClick={onPlan} title={storageState==="full"?"Лимит хранилища исчерпан — агент не может писать файлы":"Занято "+bytesLabel(plan.storageUsed)+" из "+bytesLabel(plan.storageLimit)+" — откройте тариф и хранилище"}>
      <HardDrive size={11}/>
      <span>{storageState==="full"?"Хранилище заполнено":"Хранилище "+Math.round(storageRatio*100)+"%"}</span>
      <small>{bytesLabel(plan.storageUsed)}</small>
    </button>}
  </>;
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
      <button className={"nav-item "+(view==="agent"?"active":"")} onClick={()=>onView("agent")} title="Чат с агентом"><Bot size={14}/> Агент</button>
      <button className={"nav-item "+(view==="files"?"active":"")} onClick={()=>onView("files")} title="Файлы проекта и редактор"><FolderGit2 size={14}/> Файлы</button>
      <button className={"nav-item "+(view==="changes"?"active":"")} onClick={()=>onView("changes")} title="История версий и отправка на GitHub"><History size={14}/> Изменения</button>
      <button className={"nav-item "+(view==="terminal"?"active":"")} onClick={()=>onView("terminal")} title="Команды в папке проекта"><Terminal size={14}/> Терминал</button>
    </div>
    <div className="sidebar-footer">
      <SidebarPlan onPlan={onPlan}/>
      <SidebarBanner/>
    </div>
  </aside>;
}
