import { useEffect,useMemo,useState } from "react";
import { ArrowUpRight,CreditCard,HardDrive,Pin,Plus,Trash2 } from "lucide-react";
import { SidebarBanner } from "./SidebarBanner";
import { NestLoader } from "../../components/NestLoader";
import { bytesLabel, getBilling } from "../../lib/billing-api";
import { activePlanId, chosenPlanId, isPendingChoice, planName, usePlanChoice } from "../../lib/plan-choice";
import { CHAT_GROUP_LABELS, formatSessionTime, groupChats, readPinnedChats, writePinnedChats } from "../agent/ChatSessions";
import { publicUserMessage } from "../../lib/agent-kickoff";
import type { ConversationSummary } from "../../lib/project-api";

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

/** Всё, что колонке нужно знать о чатах проекта: список и три действия над ним. */
export type SidebarChats={
  projectId:string;
  activeId:string;
  sessions:ConversationSummary[]|null;
  error:string;
  onNew:()=>Promise<void>;
  onOpen:(id:string)=>void;
  onDelete:(session:ConversationSummary)=>Promise<void>;
};

/**
 * Колонка рабочей области — чаты проекта, как в чат-интерфейсах: сверху «Новый чат», ниже
 * закреплённые и остальные по датам, внизу тариф и баннер поддержки. Разделы (агент, файлы,
 * Git, терминал) живут строкой вкладок над содержимым, поэтому здесь их нет: колонка отвечает
 * только за то, какой чат открыт.
 *
 * Закрепление поднимает чат над датами: у долгой работы бывает один главный разговор, к
 * которому возвращаются чаще остальных.
 */
export function Sidebar({open,chats,onPlan}:{open:boolean;chats:SidebarChats;onPlan:()=>void}){
  const [pinned,setPinned]=useState<string[]>(()=>readPinnedChats(chats.projectId));
  const [busy,setBusy]=useState(false);
  const [deleting,setDeleting]=useState("");
  const [actionError,setActionError]=useState("");
  // Другой проект — другие закрепления: они хранятся по проекту, а не на всю учётную запись.
  useEffect(()=>{setPinned(readPinnedChats(chats.projectId));setActionError("")},[chats.projectId]);

  const groups=useMemo(()=>groupChats(chats.sessions??[],pinned),[chats.sessions,pinned]);

  function togglePin(id:string){
    const next=pinned.includes(id)?pinned.filter(item=>item!==id):[...pinned,id];
    setPinned(next);
    writePinnedChats(chats.projectId,next);
  }

  async function startChat(){
    if(busy)return;
    setBusy(true);
    setActionError("");
    try{await chats.onNew()}
    catch(error){setActionError(error instanceof Error?error.message:"Не удалось создать чат")}
    finally{setBusy(false)}
  }

  /**
   * Удаление чата не трогает проект: файлы, настройки и остальные переписки остаются. Что
   * открыть вместо удалённого, решает рабочая область — колонка только спрашивает подтверждение.
   */
  async function removeChat(session:ConversationSummary){
    if(deleting)return;
    const label=publicUserMessage(session.label||session.title).text;
    if(!window.confirm(`Удалить чат «${label}»?\n\nПереписка и план этого чата будут удалены. Файлы проекта и остальные чаты останутся. Это действие нельзя отменить.`))return;
    setDeleting(session.id);
    setActionError("");
    try{
      await chats.onDelete(session);
      if(pinned.includes(session.id)){
        const next=pinned.filter(item=>item!==session.id);
        setPinned(next);
        writePinnedChats(chats.projectId,next);
      }
    }catch(error){
      setActionError(error instanceof Error?error.message:"Не удалось удалить чат");
    }finally{setDeleting("")}
  }

  const notice=actionError||chats.error;

  return <aside id="workspace-sidebar" className={"sidebar chats-sidebar"+(open?" open":"")}>
    <div className="chat-side-top">
      <button className="chat-side-new" onClick={()=>void startChat()} disabled={busy} title="Новый чат в этом проекте">
        {busy?<NestLoader size={14}/>:<Plus size={14}/>}
        <span>Новый чат</span>
      </button>
    </div>

    <nav className="chat-side-scroll" aria-label="Чаты проекта">
      {notice&&<div className="chat-side-error" role="alert">{notice}</div>}
      {chats.sessions===null&&!chats.error&&<div className="chat-side-state"><NestLoader size={20}/><span>Загружаем чаты…</span></div>}
      {chats.sessions?.length===0&&!notice&&<div className="chat-side-state">Чатов пока нет. Начните новый — он появится здесь.</div>}
      {groups.map(group=><div className="chat-side-group-wrap" key={group.id}>
        <div className="chat-side-group">{CHAT_GROUP_LABELS[group.id]}</div>
        {group.items.map(session=>{
          // Название приходит из сохранённых сообщений, а первое из них бывает автозапуском с
          // инструкциями агенту. Человеку показывается тот же очищенный текст, что и в переписке.
          const label=publicUserMessage(session.label||session.title).text;
          const active=session.id===chats.activeId;
          const isPinned=pinned.includes(session.id);
          return <div key={session.id} className={"chat-side-row"+(active?" active":"")+(isPinned?" pinned":"")}>
            <button className="chat-side-open" onClick={()=>chats.onOpen(session.id)} title={label} aria-current={active?true:undefined}>
              <span className="chat-side-title">
                {isPinned&&<Pin size={9} className="chat-side-mark"/>}
                <span className="chat-side-label">{label}</span>
              </span>
              <span className="chat-side-time">{formatSessionTime(session.updatedAt)}</span>
            </button>
            <div className="chat-side-tools">
              <button
                className={"chat-side-tool"+(isPinned?" is-on":"")}
                onClick={()=>togglePin(session.id)}
                title={isPinned?"Открепить чат":"Закрепить чат наверху"}
                aria-pressed={isPinned}
                aria-label={(isPinned?"Открепить чат «":"Закрепить чат «")+label+"»"}
              ><Pin size={11}/></button>
              <button
                className="chat-side-tool danger"
                onClick={()=>void removeChat(session)}
                disabled={Boolean(deleting)}
                title="Удалить чат"
                aria-label={"Удалить чат «"+label+"»"}
              >{deleting===session.id?<NestLoader size={11}/>:<Trash2 size={11}/>}</button>
            </div>
          </div>;
        })}
      </div>)}
    </nav>

    <div className="sidebar-footer">
      <SidebarPlan onPlan={onPlan}/>
      <SidebarBanner/>
    </div>
  </aside>;
}
