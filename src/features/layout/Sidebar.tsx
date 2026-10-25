import { useEffect,useState } from "react";
import { ArrowUpRight,Bot,CreditCard,FolderGit2,HardDrive,History,Home,ListTodo,Terminal } from "lucide-react";
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
 * Бесплатный лимит в колонке. Считать «шаги» человеку неудобно: внутри одного запуска агент делает
 * много шагов, а ограничение — дневные запуски на встроенной модели. Поэтому показывается доля
 * израсходованного: 4 из 10 — это 40 %, без токенов и без арифметики в голове.
 * Цвет шкалы — не украшение: к концу лимита он плавно уходит от хаки к красному.
 */
function stepsAccent(ratio:number){
  const t=Math.max(0,Math.min(1,ratio));
  // 0–60 %: хаки → янтарь, 60–100 %: янтарь → красный.
  const stops:[number,[number,number,number]][] = [[0,[202,184,152]],[0.6,[223,176,105]],[1,[224,100,92]]];
  const upper=t<=0.6?1:2;
  const [fromAt,from]=stops[upper-1];
  const [toAt,to]=stops[upper];
  const k=Math.max(0,Math.min(1,(t-fromAt)/Math.max(0.0001,toAt-fromAt)));
  // Шестнадцатеричный формат: к нему можно дописать альфу для тени (`…55`).
  return "#"+from.map((value,index)=>Math.round(value+(to[index]-value)*k).toString(16).padStart(2,"0")).join("");
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
  const ratio=free?Math.max(0,Math.min(1,plan.used/plan.limit)):0;
  const percent=Math.round(ratio*100);
  const accent=stepsAccent(ratio);
  const left=Math.max(0,plan.limit-plan.used);
  // Хранилище показывается только когда оно близко к концу: в спокойном состоянии это
  // лишняя строка, а на 80% и 100% — новость, которую нельзя пропустить.
  const storageRatio=plan.storageLimit>0?plan.storageUsed/plan.storageLimit:0;
  const storageState=storageRatio>=1?"full":storageRatio>=0.8?"warn":"";
  return <>
    <button className={"sidebar-plan"+(plan.chosen?" sidebar-plan-upgrade":"")} onClick={onPlan} title={"Тариф: "+plan.name+(plan.chosen?" · выбран "+plan.chosen:"")}>
      <span className="sidebar-plan-icon"><CreditCard size={12}/></span>
      <span className="sidebar-plan-copy"><small>Тариф</small><strong>{plan.name}</strong></span>
      {plan.chosen&&<span className="sidebar-plan-next"><ArrowUpRight size={11}/>{plan.chosen}</span>}
    </button>
    {free&&<div className="sidebar-steps" title={left>0?"Использовано "+plan.used+" из "+plan.limit+" бесплатных запусков агента · осталось "+left:"Бесплатные запуски агента на сегодня закончились"}>
      <div className="sidebar-steps-head"><span>Бесплатные запуски</span><strong style={{color:accent}}>{percent}%</strong></div>
      <div className="sidebar-steps-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent+"%"} aria-label="Использование бесплатных запусков агента">
        <span style={{width:percent+"%",background:"linear-gradient(90deg,#876832,"+accent+")",boxShadow:percent>0?"0 0 6px "+accent+"55":"none"}}/>
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
      <button className={"nav-item "+(view==="tasks"?"active":"")} onClick={()=>onView("tasks")} title="Задачи проекта: список дел, который агент читает по запросу"><ListTodo size={14}/> Задачи</button>
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
