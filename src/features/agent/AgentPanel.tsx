import { useCallback,useEffect,useRef,useState } from "react";
import { AlertTriangle,ArrowLeftRight,ClipboardList,Code2,Cpu,FileText,Image as ImageIcon,ListPlus,MessagesSquare,Paperclip,Play,Plus,RotateCcw,Send,Sparkles,Square,X } from "lucide-react";
import { createAgentSocket } from "../../lib/agent-socket";
import { apiJson } from "../../lib/api";
import { createConversation,getConversation,listConversations,uploadProjectFile,type ConversationSummary } from "../../lib/project-api";
import { NestLoader } from "../../components/NestLoader";
import { ActionsPanel,MessageThinking,PlanPanel,actionTarget,deriveActions,readPlan,writePlan,type PanelId,type PanelState } from "./agent-activity";
import type { AgentAction,AgentMode,ChatMessage,PlanState } from "../../lib/types";

const modeKey="webnestdev.agentMode";
const panelsKey="webnestdev.runPanels";

/**
 * The three run windows collapse and remember their state. They live in their own
 * region above the messages, each with its own scroll, so a long list of actions no
 * longer pushes the conversation down while the agent works.
 */
function readPanelState():PanelState{
  try{
    const raw=localStorage.getItem(panelsKey);
    if(raw){
      const parsed=JSON.parse(raw) as Partial<PanelState>;
      return {plan:parsed.plan!==false,actions:parsed.actions!==false};
    }
  }catch{}
  return {plan:true,actions:true};
}

/**
 * Что панель отправляет на каждый запуск: реплики пользователя, и только они.
 *
 * Историю модели владеет сервер: он читает сохранённую сессию и передаёт её в рантайм, поэтому
 * ответы агента и результаты инструментов в запросе не нужны — они там полнее, чем здесь (панель
 * видит только то, что успела получить потоком). Клиентский список нужен для одного: сервер
 * сравнивает его с сессией и дописывает то, чего в ней ещё нет (маршрут agent-ws). Отправка всей
 * переписки означала бы, что длинный диалог уезжает по сети целиком на каждый шаг, а его длина
 * ограничивает запрос ещё до того, как запуск начнётся.
 */
function toUserTurns(messages:ChatMessage[]){
  return messages
    .filter(message=>message.role==="user")
    .map(message=>({role:"user" as const,content:message.content}));
}
/** The mode is a user choice, so it survives reloads and is sent with every run. */
function readStoredMode():AgentMode{
  try{return localStorage.getItem(modeKey)==="planner"?"planner":"developer"}catch{return "developer"}
}

type Attachment={id:string;name:string;path:string;bytes:number;image:boolean};
type QueuedMessage={id:string;text:string;attachments:Attachment[]};
/**
 * Сколько раз панель переподключается к серверу сама, прежде чем отдать решение пользователю.
 * Две попытки закрывают короткий обрыв сети или перезапуск сервера; дальше нужен явный «Продолжить»,
 * иначе долгий сбой превратился бы в бесконечный цикл попыток.
 */
const MAX_AUTO_RESUME=2;

/** The provider state the composer reads to show the model a run will use. */
type ProviderStatus={configured:boolean;provider:string;model:string;platformDefault?:{available:boolean;providerName:string;model:string}|null};
type ModelInfo={model:string;provider:string;source:"project"|"platform"|"none"|"unknown"};

const MAX_UPLOAD_BYTES=1_200_000;

function nextId(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}

function formatBytes(bytes:number){
  if(bytes<1024)return bytes+" Б";
  if(bytes<1024*1024)return Math.round(bytes/1024)+" КБ";
  return (bytes/1024/1024).toFixed(1)+" МБ";
}

/** A chat row says when it was last touched, not a full timestamp. */
function formatSessionTime(value:string){
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return "";
  const today=new Date();
  if(date.toDateString()===today.toDateString())return date.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
  return date.toLocaleDateString("ru-RU",{day:"numeric",month:"short"});
}

function readAsBase64(file:File){
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("Не удалось прочитать файл"));
    reader.onload=()=>{
      const value=String(reader.result??"");
      resolve(value.slice(value.indexOf(",")+1));
    };
    reader.readAsDataURL(file);
  });
}

/** The agent reads text, so attachments are announced by the path they were stored at. */
function withAttachments(text:string,attachments:Attachment[]){
  if(!attachments.length)return text;
  const list=attachments.map(item=>"- "+item.path+(item.image?" (изображение)":" (файл)")).join("\n");
  return text+"\n\nЭти файлы уже лежат в проекте, используй их по путям:\n"+list;
}

/**
 * Запуск, оборвавшийся вместо завершения — перезагрузка вкладки, перезапуск сервера, потеря сети —
 * остаётся в истории ходом без финального ответа: последнее сообщение либо результат инструмента, либо
 * ответ модели с вызовами, на которые результата уже нет. По этому признаку панель после перезагрузки
 * понимает, что работа не закончена, и предлагает продолжить с того же места.
 */
function interruptedRun(messages:ChatMessage[]):{reason:string;label:string}|null{
  const last=messages.at(-1);
  if(!last)return null;
  const pending=last.role==="tool"||(last.role==="assistant"&&Boolean(last.tool_calls?.length));
  if(!pending)return null;
  return {reason:"предыдущий запуск был прерван и не завершён",label:"Прошлый запуск прервался — агент продолжит с того же места."};
}

export function AgentPanel({projectId,conversationId,onOpenConversation,onChanged,onOpenModelSettings,onOpenAccountSettings,onRunningChange}:{projectId:string;conversationId:string;onOpenConversation:(id:string)=>void;onChanged:()=>void;onOpenModelSettings?:()=>void;onOpenAccountSettings?:()=>void;onRunningChange?:(running:boolean)=>void}){
  const [messages,setMessages]=useState<ChatMessage[]>([]);
  const [prompt,setPrompt]=useState<string>(()=>{try{return localStorage.getItem("webnestdev.draft."+conversationId)??""}catch(_){return ""}});
  const [running,setRunning]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [queue,setQueue]=useState<QueuedMessage[]>([]);
  const [attachments,setAttachments]=useState<Attachment[]>([]);
  const [uploading,setUploading]=useState(false);
  const [notice,setNotice]=useState("");
  // The plan and the actions of the latest run are what the user watches while the
  // agent works, so they live here next to the messages.
  const [mode,setMode]=useState<AgentMode>(readStoredMode);
  const [modelInfo,setModelInfo]=useState<ModelInfo|null>(null);
  const [plan,setPlan]=useState<PlanState|null>(()=>readPlan(conversationId));
  const [actions,setActions]=useState<AgentAction[]>([]);
  const [panels,setPanels]=useState<PanelState>(readPanelState);
  const [progress,setProgress]=useState<{step:number;maxSteps:number;tokens?:number;budget?:number}|null>(null);
  // When the current run started: the thinking container of the answer shows the elapsed time, so a
  // model that streams no reasoning does not look like a hang.
  const [runStartedAt,setRunStartedAt]=useState<number|null>(null);
  const [quotaNotice,setQuotaNotice]=useState<"storage"|"daily"|null>(null);
  // The project's saved chats. The list comes from the server, so a chat is something
  // the user can return to from another device, not just from this browser.
  const [sessionsOpen,setSessionsOpen]=useState(false);
  const [sessions,setSessions]=useState<ConversationSummary[]|null>(null);
  const [sessionsError,setSessionsError]=useState("");
  const [sessionBusy,setSessionBusy]=useState(false);
  // Остановленный запуск — не потеря задачи: история и план уже на сервере, поэтому панель
  // держит кнопку «Продолжить», пока пользователь не продолжит или не отправит новое сообщение.
  const [resume,setResume]=useState<{reason:string;label:string}|null>(null);
  // Автоматическое переподключение: сколько попыток сделано и сколько осталось.
  const [reconnect,setReconnect]=useState<{attempt:number;max:number}|null>(null);
  const socketRef=useRef<WebSocket|null>(null);
  const actionsRef=useRef<AgentAction[]>([]);
  // Сокет закрыт нами (остановка, завершение запуска) — тогда обрыв не считается потерей связи.
  const closedByUsRef=useRef(false);
  /** Запуск дошёл до конца: новые ответы после этого не могут быть его продолжением. */
  const completedRef=useRef(false);
  // Сколько ограниченных автопереподключений уже сделано; сбрасывается в ноль при новом запуске.
  const autoResumeRef=useRef(0);
  const autoResumeTimerRef=useRef<number|null>(null);
  // Queued messages start runs from socket callbacks, so the mode is read from a ref.
  const modeRef=useRef<AgentMode>(mode);
  const fileRef=useRef<HTMLInputElement|null>(null);
  // The socket callbacks and the queue drain start new runs, so they read the latest
  // conversation and queue from refs instead of the render they were created in.
  const messagesRef=useRef<ChatMessage[]>([]);
  const queueRef=useRef<QueuedMessage[]>([]);

  useEffect(()=>{queueRef.current=queue},[queue]);

  // Запуск сообщается наверх: рабочая область и главная по этому признаку знают, что агент
  // продолжает работать над проектом, даже когда панель не на экране.
  useEffect(()=>{onRunningChange?.(running)},[running,onRunningChange]);

  // The composer draft belongs to the conversation, so it survives reloads and tab switches.
  useEffect(()=>{
    try{
      if(prompt)localStorage.setItem("webnestdev.draft."+conversationId,prompt);
      else localStorage.removeItem("webnestdev.draft."+conversationId);
    }catch{}
  },[prompt,conversationId]);

  function updateMessages(updater:(current:ChatMessage[])=>ChatMessage[]){
    messagesRef.current=updater(messagesRef.current);
    setMessages(messagesRef.current);
  }

  function replaceMessages(next:ChatMessage[]){
    messagesRef.current=next;
    setMessages(next);
  }

  function updateActions(updater:(current:AgentAction[])=>AgentAction[]){
    actionsRef.current=updater(actionsRef.current);
    setActions(actionsRef.current);
  }

  function togglePanel(id:PanelId){
    setPanels(current=>{
      const next={...current,[id]:!current[id]};
      try{localStorage.setItem(panelsKey,JSON.stringify(next))}catch{}
      return next;
    });
  }

  function chooseMode(next:AgentMode){
    modeRef.current=next;
    setMode(next);
    try{localStorage.setItem(modeKey,next)}catch{}
  }

  /** Stores the plan per conversation so a panel remount keeps showing it. */
  function updatePlan(next:PlanState){
    setPlan(next);
    writePlan(conversationId,next);
  }

  /** Отложенное автоматическое переподключение отменяется, когда панель переключает чат или размонтируется. */
  function cancelAutoResume(){
    if(autoResumeTimerRef.current!==null){window.clearTimeout(autoResumeTimerRef.current);autoResumeTimerRef.current=null}
  }

  useEffect(()=>()=>cancelAutoResume(),[]);

  /** A cancelled or aborted run leaves rows spinning, so they are settled as failed. */
  function settleActions(){
    updateActions(current=>current.map(action=>action.status==="running"?{...action,status:"failed" as const,durationMs:Date.now()-action.startedAt}:action));
  }

  useEffect(()=>{
    let cancelled=false;
    setLoaded(false);
    queueRef.current=[];setQueue([]);
    setAttachments([]);setNotice("");
    cancelAutoResume();
    autoResumeRef.current=0;setReconnect(null);setResume(null);closedByUsRef.current=true;
    actionsRef.current=[];setActions([]);setProgress(null);
    setPlan(readPlan(conversationId));
    void getConversation(conversationId).then(conversation=>{
      if(cancelled)return;
      // The whole stored history comes back: answers, the thinking that now sits above each of them
      // and the tool results that say how each action ended.
      const persisted=Array.isArray(conversation.messages)?conversation.messages:[];
      replaceMessages(persisted.length?persisted:[{role:"assistant",content:"Привет. Я WebNestdev — веб-агент для создания и развития проектов. Опиши, что нужно сделать."}]);
      actionsRef.current=deriveActions(persisted);
      setActions(actionsRef.current);
      // The plan is stored with the conversation; localStorage is only the fallback.
      setPlan(conversation.plan??readPlan(conversationId));
      // Диалог, в котором запуск не дошёл до ответа, открывается сразу с кнопкой «Продолжить».
      setResume(interruptedRun(persisted));
      setLoaded(true);
    }).catch(()=>{
      if(cancelled)return;
      replaceMessages([{role:"assistant",content:"Не удалось загрузить историю этой сессии."}]);
      setLoaded(true);
    });
    return()=>{cancelled=true;socketRef.current?.close();socketRef.current=null};
  },[conversationId]);

  const loadSessions=useCallback(async()=>{
    try{
      setSessionsError("");
      setSessions((await listConversations(projectId)).conversations);
    }catch(error){
      setSessionsError(error instanceof Error?error.message:"Не удалось загрузить список чатов");
    }
  },[projectId]);

  // Loaded for the header counter and refreshed when the open chat changes, so the list
  // and the counter stay honest after a run, a switch or a reload.
  useEffect(()=>{void loadSessions()},[loadSessions,conversationId]);

  // The model is a project setting, so the composer reads it instead of assuming one;
  // it shows the same model the runtime picks: the project one, or the platform default.
  useEffect(()=>{
    let cancelled=false;
    setModelInfo(null);
    void apiJson<ProviderStatus>(`/api/projects/${encodeURIComponent(projectId)}/provider`).then(status=>{
      if(cancelled)return;
      if(status.configured)setModelInfo({model:status.model,provider:status.provider,source:"project"});
      else if(status.platformDefault?.available)setModelInfo({model:status.platformDefault.model,provider:status.platformDefault.providerName,source:"platform"});
      else setModelInfo({model:"",provider:"",source:"none"});
    }).catch(()=>{if(!cancelled)setModelInfo({model:"",provider:"",source:"unknown"})});
    return()=>{cancelled=true};
  },[projectId]);

  /**
   * Запуск задачи. `resumeReason` означает продолжение прерванного запуска: сообщение пользователя не
   * добавляется, а сервер получает пометку, по которой модели добавляется заметка о продолжении —
   * история и план уже сохранены, поэтому работа продолжается с того же места, а не с начала.
   */
  function startRun(item:{text:string;attachments:Attachment[]}|null,options:{resumeReason?:string;auto?:boolean}={}){
    const resuming=Boolean(options.resumeReason);
    // Ручное продолжение начинает счёт попыток переподключения заново, автоматическое — продолжает
    // считать, чтобы потеря связи не превратилась в бесконечный цикл перезапусков.
    autoResumeRef.current=resuming&&options.auto?autoResumeRef.current+1:0;
    // Новое сообщение или ручное продолжение отменяет отложенную попытку: иначе она сработала бы
    // поверх только что начатого запуска и заменила его.
    if(!options.auto)cancelAutoResume();
    const content=item?withAttachments(item.text,item.attachments):"";
    const history=resuming
      ?toUserTurns(messagesRef.current)
      :[...toUserTurns(messagesRef.current),{role:"user" as const,content}];
    replaceMessages(resuming
      ?[...messagesRef.current,{role:"assistant",content:""}]
      :[...messagesRef.current,{role:"user",content},{role:"assistant",content:""}]);
    setResume(null);
    setRunning(true);
    setNotice("");
    // При автопереподключении строка «переподключаюсь…» остаётся видимой до открытия сокета: панель
    // не должна выглядеть бездействующей, пока идёт повторная попытка.
    if(!resuming)setReconnect(null);
    updateActions(()=>[]);
    setProgress(null);
    setRunStartedAt(Date.now());
    completedRef.current=false;

    /**
     * Соединение и запрос. Оборвавшийся до отправки сокет — это состояние сети, а не ошибка запуска,
     * поэтому попыток несколько с растущей паузой; оборвавшийся во время работы — это точка
     * продолжения, а не потерянная задача: история и план уже на сервере.
     */
    const connect=(attempt:number)=>{
      let opened=false;
      let settled=false;
      closedByUsRef.current=false;
      const maxAttempts=3;
      const socket=createAgentSocket(event=>{
      if(event.type==="message.delta")updateMessages(current=>{
        const next=[...current];
        const last=next.at(-1);
        if(last?.role==="assistant")next[next.length-1]={...last,content:last.content+(event.delta??"")};
        return next;
      });
      if(event.type==="reasoning.delta"&&event.delta){
        const delta=event.delta;
        // Размышление живёт на том ответе, к которому относится: оно показывается над ним, пока
        // модель работает, и сохраняется вместе с сообщением, поэтому переживает перезагрузку.
        updateMessages(current=>{
          const next=[...current];
          const last=next.at(-1);
          if(last?.role==="assistant")next[next.length-1]={...last,reasoning:(last.reasoning??"")+delta};
          return next;
        });
      }
      // The server runs only a few agents at once, so a busy moment makes the run wait instead
      // of failing. The line says so and disappears the moment the run really starts.
      if(event.type==="run.queued"||event.type==="run.started"){
        setNotice(event.type==="run.queued"?"Сервер занят другим запуском — вы в очереди"+(typeof event.queued==="number"&&event.queued>0?" (впереди: "+event.queued+")":"")+"…":"");
      }
      if(event.type==="run.progress"&&typeof event.step==="number"&&typeof event.maxSteps==="number")setProgress({step:event.step,maxSteps:event.maxSteps,...(typeof event.tokens==="number"?{tokens:event.tokens}:{}),...(typeof event.budget==="number"?{budget:event.budget}:{})});
      if(event.type==="tool.started"&&event.name){
        const name=event.name;
        const id=event.toolCallId??nextId();
        // Publishing the plan already updates the plan card, so it is not repeated here.
        if(name!=="plan.update")updateActions(current=>[...current,{id,name,target:actionTarget(name,event.input).slice(0,160),status:"running",startedAt:Date.now()}]);
      }
      if(event.type==="tool.finished"&&event.name){
        const id=event.toolCallId??"";
        const output=event.output as {error?:unknown}|null;
        const failed=Boolean(output&&typeof output==="object"&&"error" in output&&output.error);
        updateActions(current=>current.map(action=>action.id===id?{...action,status:failed?"failed":"done",durationMs:Date.now()-action.startedAt}:action));
      }
      if(event.type==="plan.updated"&&event.plan)updatePlan(event.plan);
      if(event.type==="run.completed"){completedRef.current=true;endRun(socket,{drain:true});onChanged();void loadSessions()}
      if(event.type==="run.failed"){
        // A run that died on the context limit has a different fix than a failed tool call, so the
        // panel says which one it is instead of leaving the user with the provider's wording.
        const overflow=event.code==="CONTEXT_OVERFLOW";
        updateMessages(current=>[...current,{role:"assistant",content:"Ошибка: "+(event.error??"неизвестная ошибка")+(overflow?"\n\nИстория этого диалога уже слишком большая для модели: начните новый диалог или разбейте задачу на части — либо нажмите «Продолжить»: история будет сокращена.":"")}]);
        endRun(socket,{drain:false,notice:overflow?"Запуск остановлен: переполнен контекст модели.":"Запуск остановлен ошибкой — можно продолжить с этого места.",resume:{
          reason:"запуск был остановлен ошибкой: "+(event.error??"неизвестная ошибка").slice(0,160),
          label:overflow?"Переполнен контекст модели: продолжение начнётся с сокращённой историей.":"Запуск остановлен ошибкой — агент продолжит с того же места.",
        }});
      }
      if(event.type==="error"){
        const errorMsg = event.error ?? "соединение потеряно";
        const isStorageLimit = event.code === "STORAGE_LIMIT_REACHED";
        const isDailyQuota = event.code === "DAILY_QUOTA_EXCEEDED";
        // The server is at its parallel-run limit: the queue was full or the wait ran out.
        const isBusy = event.code === "SERVER_BUSY";
        // One account runs one agent at a time, so a second tab or project is turned away.
        const isAccountBusy = event.code === "RUN_ALREADY_ACTIVE";
        const quotaKind = isStorageLimit ? "storage" : isDailyQuota ? "daily" : null;
        updateMessages(current=>[...current,{role:"assistant",content:(quotaKind==="storage"?"Достигнут лимит хранилища вашего тарифа. ":quotaKind==="daily"?"Дневной лимит запусков агента исчерпан. ":isAccountBusy?"Агент уже работает в этом аккаунте. ":isBusy?"Сервер занят. ":"Ошибка: ")+errorMsg}]);
        if(quotaKind)setQuotaNotice(quotaKind);
        // Тариф и очередь аккаунта требуют не «Продолжить», а действия с тарифом или ожидания: у этих
        // отказов запуск даже не начался, и кнопка продолжения только запутала бы.
        const resumable=!quotaKind&&!isAccountBusy;
        endRun(socket,{drain:false,notice:quotaKind==="storage"?"Хранилище заполнено — обновите тариф":quotaKind==="daily"?"Дневной лимит исчерпан":isAccountBusy?"Агент уже работает в этом аккаунте — дождитесь завершения или остановите его":isBusy?"Сервер занят — повторите запуск позже":"Запуск остановлен",...(resumable?{resume:{reason:"запуск был отклонён сервером: "+errorMsg.slice(0,160),label:"Запуск остановлен — агент продолжит с того же места."}}:{})});
      }
    },()=>drop());
      socketRef.current=socket;
      // Обрыв виден и как ошибка, и как закрытие: сервер отдаёт "connection closed before
      // receiving a handshake response" без ошибки, поэтому считаем и close.
      socket.addEventListener("close",()=>drop());
      socket.addEventListener("open",()=>{
        opened=true;
        setReconnect(null);
        socket.send(JSON.stringify({type:"agent.run",request:{projectId,conversationId,messages:history,mode:modeRef.current,...(resuming?{resume:{reason:options.resumeReason}}:{})}}));
      },{once:true});

      /**
       * Обрыв соединения. Пока сокет не открылся, это состояние сети — панель сама повторяет попытки.
       * Если связь потеряна во время работы, сервер уже остановил запуск, а история и план сохранены:
       * панель сначала переподключается и продолжает сама, и только исчерпав попытки показывает кнопку
       * «Продолжить» — так задача не ждёт пользователя из-за пары секунд без сети.
       */
      function drop(){
        if(settled||closedByUsRef.current||completedRef.current||socketRef.current!==socket)return;
        settled=true;
        if(!opened&&attempt<maxAttempts){
          setReconnect({attempt:attempt+1,max:maxAttempts});
          window.setTimeout(()=>{if(!closedByUsRef.current&&socketRef.current===socket)connect(attempt+1)},700*(attempt+1)*(attempt+1));
          return;
        }
        const reason="связь с сервером прервалась во время работы";
        if(autoResumeRef.current<MAX_AUTO_RESUME){
          const attemptNumber=autoResumeRef.current+1;
          setReconnect({attempt:attemptNumber,max:MAX_AUTO_RESUME});
          setNotice("Связь с сервером прервалась — переподключаюсь и продолжаю с того же места…");
          updateMessages(current=>{
            const next=[...current];
            const last=next.at(-1);
            const text="Связь с сервером прервалась — продолжаю с того же места.";
            if(last?.role==="assistant")next[next.length-1]={...last,content:(last.content?last.content+"\n\n":"")+text};
            else next.push({role:"assistant",content:text});
            return next;
          });
          cancelAutoResume();
          autoResumeTimerRef.current=window.setTimeout(()=>{
            autoResumeTimerRef.current=null;
            if(closedByUsRef.current)return;
            startRun(null,{resumeReason:reason,auto:true});
          },1200*attemptNumber);
          // Сокет мёртв, поэтому ссылка освобождается сразу: следующая попытка создаст новый.
          socketRef.current=null;
          setRunning(false);
          setRunStartedAt(null);
          settleActions();
          return;
        }
        setReconnect(null);
        updateMessages(current=>[...current,{role:"assistant",content:"Соединение с Agent Runtime прервалось во время работы."}]);
        endRun(null,{drain:false,notice:"Связь потеряна — нажмите «Продолжить», чтобы агент вернулся к тому же шагу.",resume:{reason,label:"Связь потеряна: запуск продолжится с того же места."}});
      }
    };
    connect(0);
  }

  /**
   * Конец запуска: панель выходит из состояния «работает» и решает, что показать дальше.
   * `resume` включает кнопку «Продолжить» — так завершается любой остановленный запуск, кроме
   * успешного: история и план уже сохранены, поэтому продолжение начинается с того же места.
   */
  function endRun(socket:WebSocket|null,options:{drain:boolean;notice?:string;resume?:{reason:string;label:string}}){
    closedByUsRef.current=true;
    if(socket&&socketRef.current===socket)socketRef.current=null;
    if(socket)try{socket.close()}catch{}
    setRunning(false);
    setRunStartedAt(null);
    setReconnect(null);
    settleActions();
    setResume(options.resume??null);
    if(options.notice)setNotice(options.notice);
    if(!options.drain)return;
    // The queue keeps working while the agent is busy, so a finished task hands over
    // to the next message without the user having to press anything.
    const next=queueRef.current[0];
    if(!next)return;
    queueRef.current=queueRef.current.slice(1);
    setQueue(queueRef.current);
    startRun(next);
  }

  /**
   * Stops the run in flight; the server aborts its work when the socket closes. `resume: false` is for
   * the case where another message is starting right away: a continuation button there would point at
   * a run the user has already replaced.
   */
  function interrupt(options:{resume?:boolean}={}){
    closedByUsRef.current=true;
    const socket=socketRef.current;
    socketRef.current=null;
    if(socket)try{socket.close()}catch{}
    setRunning(false);
    setRunStartedAt(null);
    setReconnect(null);
    settleActions();
    setResume(options.resume===false?null:{reason:"пользователь остановил запуск вручную",label:"Запуск остановлен вами — агент продолжит с того же места."});
    updateMessages(current=>{
      const next=[...current];
      const last=next.at(-1);
      if(last?.role==="assistant")next[next.length-1]={role:"assistant",content:last.content?last.content+"\n\n— остановлено —":"Выполнение остановлено."};
      return next;
    });
  }

  function stop(){
    if(!running)return;
    interrupt();
    setNotice(queueRef.current.length?"Очередь ждёт: отправьте сообщение кнопкой «Отправить сейчас».":"Выполнение остановлено — можно продолжить с этого же места.");
  }

  /** Продолжение прерванного запуска: без нового сообщения и с пометкой для модели. */
  function continueRun(){
    if(running||!resume)return;
    startRun(null,{resumeReason:resume.reason});
  }

  /** Остановка другим сообщением: кнопка продолжения относилась бы к уже заменённому запуску. */
  function interruptForNewRun(){
    if(running)interrupt({resume:false});
  }

  function send(){
    const text=prompt.trim();
    if(!text||!loaded)return;
    const item:QueuedMessage={id:nextId(),text,attachments};
    setPrompt("");
    setAttachments([]);
    if(running){
      queueRef.current=[...queueRef.current,item];
      setQueue(queueRef.current);
      return;
    }
    startRun(item);
  }

  function sendQueuedNow(id:string){
    const item=queueRef.current.find(entry=>entry.id===id);
    if(!item)return;
    queueRef.current=queueRef.current.filter(entry=>entry.id!==id);
    setQueue(queueRef.current);
    interruptForNewRun();
    startRun(item);
  }

  function removeQueued(id:string){
    queueRef.current=queueRef.current.filter(entry=>entry.id!==id);
    setQueue(queueRef.current);
  }

  /** Another chat of the same project: the panel loads its stored turns on switch. */
  function openSession(id:string){
    setSessionsOpen(false);
    if(id!==conversationId)onOpenConversation(id);
  }

  /** A finished thread can be left as it is: a project keeps several chats side by side. */
  async function startSession(){
    setSessionBusy(true);
    setSessionsError("");
    try{
      const created=await createConversation(projectId);
      setSessionsOpen(false);
      onOpenConversation(created.id);
      void loadSessions();
    }catch(error){
      setSessionsError(error instanceof Error?error.message:"Не удалось создать сессию");
    }finally{
      setSessionBusy(false);
    }
  }

  async function pickFiles(files:FileList|null){
    if(!files?.length)return;
    setNotice("");
    setUploading(true);
    const uploaded:Attachment[]=[];
    const errors:string[]=[];
    try{
      for(const file of Array.from(files)){
        if(file.size>MAX_UPLOAD_BYTES){errors.push(file.name+": больше "+formatBytes(MAX_UPLOAD_BYTES));continue}
        try{
          const data=await readAsBase64(file);
          const result=await uploadProjectFile(projectId,{name:file.name,data});
          uploaded.push({id:result.path,name:result.name,path:result.path,bytes:result.bytes,image:file.type.startsWith("image/")||/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(file.name)});
        }catch(error){
          errors.push(file.name+": "+(error instanceof Error?error.message:"не удалось загрузить"));
        }
      }
      if(uploaded.length)setAttachments(current=>[...current,...uploaded]);
      if(errors.length)setNotice(errors.join(" · "));
    }finally{
      setUploading(false);
      if(fileRef.current)fileRef.current.value="";
    }
  }

  // Gateway model ids carry a folder prefix (gpt://<folder>/<model>), so the chip shows
  // the model itself and the tooltip keeps the full id.
  const modeLabel=mode==="planner"?"Планировщик":"Разработчик";
  const modeTitle=mode==="planner"
    ?"Сейчас планировщик: агент изучает проект и составляет план, не меняя файлы. Нажмите, чтобы включить режим разработчика."
    :"Сейчас разработчик: агент пишет код, запускает проверки и меняет проект. Нажмите, чтобы включить режим планировщика.";
  const modelName=modelInfo?modelInfo.model.split("/").pop()||"Модель не настроена":"Определяем модель…";
  const modelDetails=[modelInfo?.provider,modelInfo?.model].filter(Boolean).join(" · ");
  const modelTitle=!modelInfo
    ?"Выбранная модель появится здесь"
    :modelInfo.model
      ?(modelInfo.source==="platform"?"Модель платформы":"Модель проекта")+": "+modelDetails+". Нажмите, чтобы открыть настройки AI-провайдера."
      :"AI-провайдер не настроен. Нажмите, чтобы указать Base URL и модель.";

  // Tool results are part of the stored history but not of the transcript; the action
  // list is built from them instead.
  const visibleMessages=messages.filter(message=>message.role!=="tool");

  return <section className="chat">
    <div className="chat-header">
      <div><div className="eyebrow">АГЕНТ</div><h1>Что создаём?</h1></div>
      <button type="button" className="chat-sessions-button" onClick={()=>{setSessionsOpen(true);void loadSessions()}} title="Сохранённые чаты проекта — вернуться к любому" aria-label="Чаты проекта">
        <MessagesSquare size={14}/>
        <span>Чаты{sessions&&sessions.length>1?" · "+sessions.length:""}</span>
      </button>
    </div>

    <div className="messages">
      {visibleMessages.map((m,i)=>{
        // Ответ, который модель пишет прямо сейчас: над ним идёт её размышление.
        const live=running&&i===visibleMessages.length-1;
        return <div className={"message-row "+m.role} key={i}>
          <div className="message-avatar">{m.role==="assistant"?<Sparkles size={14}/>:"Вы"}</div>
          <div className="message-content">
            <div className="message-role">{m.role==="assistant"?"WebNestdev":"Вы"}</div>
            {/* Размышление — над ответом, в своём контейнере, который можно свернуть и развернуть. */}
            {m.role==="assistant"&&(m.reasoning||live)&&<MessageThinking text={m.reasoning??""} running={live} progress={progress} startedAt={runStartedAt}/>}
            <div className="message-text">{m.content || (running ? <NestLoader size={34} label="WebNestdev выполняет задачу" /> : "")}</div>
          </div>
        </div>;
      })}

      {queue.length>0&&<div className="message-queue">
        <div className="message-queue-head"><ListPlus size={13}/> В очереди: {queue.length}</div>
        <ul>{queue.map(item=><li key={item.id}>
          <div className="message-queue-text">
            <span>{item.text}</span>
            {item.attachments.length>0&&<small>{item.attachments.map(attachment=>attachment.name).join(", ")}</small>}
          </div>
          <button className="ghost-button message-queue-send" onClick={()=>sendQueuedNow(item.id)} title={running?"Прервать текущую задачу и отправить это сообщение":"Отправить это сообщение"}>Отправить сейчас</button>
          <button className="icon-button" onClick={()=>removeQueued(item.id)} title="Убрать из очереди" aria-label="Убрать из очереди"><X size={13}/></button>
        </li>)}</ul>
      </div>}
    </div>

    {/* План и действия — у поля ввода: они относятся к тому, что происходит сейчас, и не должны
        уезжать вверх вместе с длинной перепиской. */}
    {(plan&&plan.items.length>0)||actions.length>0||running
      ?<div className="chat-status chat-status-bottom">
        {plan&&plan.items.length>0&&<PlanPanel plan={plan} collapsed={panels} onToggle={togglePanel}/>}
        {(actions.length>0||running)&&<ActionsPanel actions={actions} running={running} progress={progress} collapsed={panels} onToggle={togglePanel}/>}
      </div>
      :null}

    <div className="composer-wrap">
      {resume&&!running&&<div className="resume-bar" role="status">
        <span className="resume-text"><RotateCcw size={13}/> {resume.label}</span>
        <button className="send-button resume-button" onClick={continueRun} title="Продолжить прерванный запуск с того же шага" aria-label="Продолжить запуск"><Play size={13}/> Продолжить</button>
      </div>}
      {reconnect&&<div className="composer-notice reconnecting">Связь потеряна — переподключаюсь… попытка {reconnect.attempt}/{reconnect.max}</div>}
      <div className="composer">
        <textarea disabled={!loaded} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder={loaded?"Опишите проект или задачу...":"Загружаем сессию…"} rows={3}/>

        {attachments.length>0&&<div className="composer-attachments">
          {attachments.map(attachment=><span className="attachment-chip" key={attachment.id}>
            {attachment.image?<ImageIcon size={12}/>:<FileText size={12}/>}
            <span className="attachment-name" title={attachment.path}>{attachment.name}</span>
            <small>{formatBytes(attachment.bytes)}</small>
            <button className="icon-button attachment-remove" onClick={()=>setAttachments(current=>current.filter(item=>item.id!==attachment.id))} title="Убрать файл" aria-label={"Убрать файл "+attachment.name}><X size={12}/></button>
          </span>)}
        </div>}

        <div className="composer-footer">
          <div className="composer-tools">
            <button className="icon-button" onClick={()=>fileRef.current?.click()} disabled={!loaded||uploading} title="Прикрепить файл или изображение" aria-label="Прикрепить файл или изображение"><Paperclip size={14}/></button>
            <input ref={fileRef} type="file" multiple hidden onChange={e=>void pickFiles(e.target.files)}/>
            {/* One button, one click: it shows the mode a run will use and switches it. */}
            <button type="button" className={"mode-toggle"+(mode==="planner"?" planner":"")} data-mode={mode} onClick={()=>chooseMode(mode==="planner"?"developer":"planner")} title={modeTitle} aria-label={modeLabel+". Переключить режим агента"}>
              {mode==="planner"?<ClipboardList size={12}/>:<Code2 size={12}/>}
              <span>{modeLabel}</span>
              <ArrowLeftRight size={11}/>
            </button>
            <button type="button" className="composer-model" onClick={()=>onOpenModelSettings?.()} title={modelTitle} aria-label={"Модель: "+modelName+". Открыть настройки AI-провайдера"}>
              <Cpu size={12}/>
              <span className="composer-model-name">{modelName}</span>
            </button>
          </div>
          <div className="composer-buttons">
            {running&&<button className="send-button stop-button" onClick={stop} title="Остановить" aria-label="Остановить"><Square size={14}/></button>}
            <button className="send-button" disabled={!loaded||!prompt.trim()} onClick={send} title={running?"В очередь":"Отправить"} aria-label={running?"В очередь":"Отправить"}>{running?<ListPlus size={15}/>:<Send size={15}/>}</button>
          </div>
        </div>
        <div className="composer-hint">{uploading?"Загружаем файлы…":running?"Агент работает — сообщение встанет в очередь":mode==="planner"?"Планировщик только изучает проект и готовит план — файлы не меняются":"Enter — отправить · Shift + Enter — новая строка"}</div>
      </div>
      {notice&&<div className="composer-notice">{notice}</div>}
    </div>

    {quotaNotice&&<div className="modal-backdrop" role="presentation" onMouseDown={()=>setQuotaNotice(null)}>
      <section className="modal quota-modal" role="dialog" aria-modal="true" aria-label="Лимит тарифа достигнут" onMouseDown={event=>event.stopPropagation()}>
        <header className="modal-head">
          <div><span className="eyebrow">ЛИМИТ ТАРИФА</span><h2>{quotaNotice==="storage"?"Хранилище заполнено":"Дневной лимит исчерпан"}</h2></div>
          <button className="icon-button" onClick={()=>setQuotaNotice(null)} aria-label="Закрыть"><X size={16}/></button>
        </header>
        <div className="modal-body">
          <div className="quota-modal-icon"><AlertTriangle size={18}/></div>
          <p className="modal-lead">{quotaNotice==="storage"
            ?"Лимит хранилища вашего тарифа достигнут: агент больше не может писать файлы в проект. Освободите место или обновите тариф — лимиты: Бесплатный 1 ГБ, Про 10 ГБ, Команда 50 ГБ."
            :"Дневная квота запусков агента исчерпана. Новые запуски станут доступны после сброса по UTC или при обновлении тарифа."}</p>
        </div>
        <footer className="modal-foot">
          <button className="ghost-button" onClick={()=>setQuotaNotice(null)}>Понятно</button>
          <button className="send-button" onClick={()=>{setQuotaNotice(null);onOpenAccountSettings?.()}}>Обновить тариф</button>
        </footer>
      </section>
    </div>}

    {sessionsOpen&&<div className="modal-backdrop" role="presentation" onMouseDown={()=>setSessionsOpen(false)}>
      <section className="modal sessions-modal" role="dialog" aria-modal="true" aria-label="Чаты проекта" onMouseDown={event=>event.stopPropagation()}>
        <header className="modal-head">
          <div><span className="eyebrow">ИСТОРИЯ</span><h2>Чаты проекта</h2></div>
          <button className="icon-button" onClick={()=>setSessionsOpen(false)} aria-label="Закрыть"><X size={16}/></button>
        </header>
        <div className="modal-body">
          {sessionsError?<div className="modal-state">{sessionsError}</div>
            :sessions===null?<div className="modal-state"><NestLoader size={26}/><span>Загружаем историю…</span></div>
            :sessions.length===0?<div className="modal-state">В проекте ещё нет сохранённых чатов.</div>
            :<ul className="session-list">{sessions.map(session=><li key={session.id}>
              <button className={"session-item"+(session.id===conversationId?" active":"")} onClick={()=>openSession(session.id)} title={session.label}>
                <span className="session-item-head"><strong>{session.label}</strong><small>{formatSessionTime(session.updatedAt)}</small></span>
                {session.preview&&<span className="session-item-preview">{session.preview}</span>}
                <span className="session-item-meta">{session.messageCount} сообщ.{session.id===conversationId?" · открыт сейчас":""}</span>
              </button>
            </li>)}</ul>}
        </div>
        <footer className="modal-foot">
          <p className="modal-lead">Чаты хранятся на сервере: история проекта открывается с любого устройства и переживает перезагрузку.</p>
          <button className="send-button" onClick={()=>void startSession()} disabled={sessionBusy}><Plus size={14}/> Новая сессия</button>
        </footer>
      </section>
    </div>}
  </section>;
}
