import { useEffect,useRef,useState,type DragEvent as ReactDragEvent,type MouseEvent as ReactMouseEvent } from "react";
import Markdown,{type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle,ArrowDownToLine,Check,Copy,Cpu,Eye,EyeOff,ExternalLink,FileText,History,Image as ImageIcon,KeyRound,ListPlus,Paperclip,Play,RotateCcw,Send,ShieldCheck,Sparkles,Square,X } from "lucide-react";
import { createAgentSocket } from "../../lib/agent-socket";
import { apiJson } from "../../lib/api";
import { addProjectTasks,answerProjectQuestion,cancelProjectSecret,getConversation,listPendingProjectSecrets,skipProjectQuestion,submitProjectSecret,uploadProjectFile,type PendingProjectSecret } from "../../lib/project-api";
import { cancelProjectAccess,submitProjectAccess } from "../../lib/deployment-api";
import { NestLoader } from "../../components/NestLoader";
import { ActionsDock,MessageThinking,PlanPanel,actionTarget,contentBefore,deriveActions,readPlan,writePlan,type PanelId,type PanelState } from "./agent-activity";
import type { AgentAction,AgentMode,ChatMessage,PlanState,ReasoningEffort,ReasoningSupport } from "../../lib/types";
import { QuestionSheet,type AgentQuestion } from "./QuestionSheet";
import { AgentModeControl } from "./AgentModeControl";
import { ChatBookmarks } from "./ChatBookmarks";
import { SupportButton } from "../support/SupportDialog";
import { takeAgentStart } from "../../lib/agent-start";
import { AGENT_COMPOSE_EVENT,AGENT_DRAFT_EVENT } from "../../lib/agent-compose";
import { publicUserMessage } from "../../lib/agent-kickoff";
import { copyText } from "../../lib/clipboard";
import { parseTaskList } from "../../lib/task-parse";

const modeKey="webnestdev.agentMode";
const reasoningKey="webnestdev.reasoning";
const panelsKey="webnestdev.runPanels";
/**
 * Поиск в интернете — переключатель в меню «Режимы», рядом с глубиной размышления, по умолчанию
 * выключен. Это разрешение выйти в сеть на этот запуск, а не режим работы, поэтому сервер проверяет
 * тот же флаг: выключенный переключатель означает именно «в интернет не ходить».
 */
const webSearchKey="webnestdev.webSearch";
/**
 * Ответ агента — markdown: заголовки, списки, таблицы и блоки кода. Таблица оборачивается
 * в прокручиваемый контейнер, иначе широкая таблица растягивает всю переписку, а ссылка
 * из ответа открывается в новой вкладке, не уводя из рабочей области.
 */
const markdownComponents:Components={
  table:({node,...props})=>{void node;return <div className="md-table"><table {...props}/></div>},
};
function openMarkdownLink(event:ReactMouseEvent<HTMLDivElement>){
  const anchor=(event.target as HTMLElement).closest("a");
  const href=anchor?.getAttribute("href");
  // Только внешние ссылки уходят в новую вкладку: якоря и относительные пути должны работать
  // как обычно, а `javascript:`-адрес сюда не попадает вовсе.
  if(!href||!anchor||!/^https?:/i.test(href))return;
  event.preventDefault();
  window.open(href,"_blank","noopener,noreferrer");
}

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
/**
 * Черновик поля ввода принадлежит чату: он лежит под ключом разговора, поэтому перезагрузка
 * страницы возвращает написанный текст, а переключение чата — свой текст для каждого чата,
 * а не текст предыдущего.
 */
const draftKey=(conversationId:string)=>"webnestdev.draft."+conversationId;
function readDraft(conversationId:string){
  if(!conversationId)return "";
  try{return localStorage.getItem(draftKey(conversationId))??""}catch{return ""}
}
function writeDraft(conversationId:string,value:string){
  if(!conversationId)return;
  try{
    if(value)localStorage.setItem(draftKey(conversationId),value);
    else localStorage.removeItem(draftKey(conversationId));
  }catch{}
}

/** The mode is a user choice, so it survives reloads and is sent with every run. */
function readStoredMode():AgentMode{
  try{return localStorage.getItem(modeKey)==="planner"?"planner":"developer"}catch{return "developer"}
}

function readStoredReasoning():ReasoningEffort{
  try{
    const value=localStorage.getItem(reasoningKey);
    return value==="low"||value==="high"?value:"medium";
  }catch{return "medium"}
}

/** По умолчанию поиск выключен: в сеть агент идёт только когда человек сам включил кнопку. */
function readStoredWebSearch(){
  try{return localStorage.getItem(webSearchKey)==="on"}catch{return false}
}

/**
 * Запрос ключа, пришедший событием запуска. Значение здесь не хранится — его вводит пользователь
 * в модальном окне, и оно уходит на сервер отдельным запросом.
 */
type SecretPrompt={requestId:string;variable:string;purpose:string;file:string;/** Окно вернулось после перезагрузки: запуск уже остановлен, но ключ ещё можно сохранить. */recovered?:boolean};
/**
 * Доступ к провайдеру — не один ключ, а набор полей кабинета. Значения живут только в этом
 * состоянии до отправки; в переписку и события запуска они не попадают.
 */
type AccessPrompt={
  requestId:string;
  kind:"cloud"|"domain"|"service"|"database"|"yandex";
  provider:string;
  name:string;
  purpose:string;
  fields:Array<{key:string;label:string;placeholder:string;secret?:boolean;multiline?:boolean;optional?:boolean}>;
  steps:string[];
  keyUrl?:string;
  docsUrl?:string;
  verificationNote:string;
  writes:boolean;
  defaultAllowWrites:boolean;
};
type Attachment={id:string;name:string;path:string;bytes:number;image:boolean};
type QueuedMessage={id:string;text:string;attachments:Attachment[]};
/**
 * Сколько раз панель переподключается к серверу сама, прежде чем отдать решение пользователю.
 * Две попытки закрывают короткий обрыв сети или перезапуск сервера; дальше нужен явный «Продолжить»,
 * иначе долгий сбой превратился бы в бесконечный цикл попыток.
 */
const MAX_AUTO_RESUME=2;
/**
 * События, после которых ожидание лимита провайдера закончилось: за любым из них идёт настоящая
 * работа или конец запуска, поэтому строка «жду N с и продолжаю» должна уйти.
 */
const RETRY_NOTICE_CLEAR_EVENTS=new Set(["message.delta","reasoning.delta","tool.started","tool.finished","plan.updated","run.completed","run.failed","error"]);

/** The provider state the composer reads to show the model a run will use. */
type ProviderStatus={configured:boolean;provider:string;model:string;platformDefault?:{available:boolean;providerName:string;model:string;freeModel?:boolean}|null;reasoning?:ReasoningSupport|null};
type ModelInfo={model:string;provider:string;source:"project"|"platform"|"none"|"unknown";freeModel?:boolean};

const MAX_UPLOAD_BYTES=1_200_000;

function nextId(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}

function formatBytes(bytes:number){
  if(bytes<1024)return bytes+" Б";
  if(bytes<1024*1024)return Math.round(bytes/1024)+" КБ";
  return (bytes/1024/1024).toFixed(1)+" МБ";
}

function readAsBase64(file:Blob){
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

/**
 * Длинная сторона, до которой уменьшается фото перед загрузкой. 1800 px хватает и на весь экран
 * ретины, и на карточку галереи, а вес снимка с телефона падает с 5 МБ до 300–600 КБ — иначе
 * пачка реальных работ упиралась в лимит запроса и до проекта не доезжала.
 */
const IMAGE_MAX_EDGE=1800;
const IMAGE_QUALITY=0.82;
/** Мелкие картинки не трогаются: перекодирование только испортило бы их. */
const IMAGE_COMPRESS_ABOVE=600_000;

function webpName(name:string){
  const dot=name.lastIndexOf(".");
  return (dot>0?name.slice(0,dot):name)+".webp";
}

/**
 * Фото с телефона перед отправкой уменьшается и перекодируется в WebP (прозрачность сохраняется).
 * Оригинал уходит без изменений, если он уже лёгкий, это SVG/GIF/HEIC (их canvas не читает) или
 * браузер не смог его разобрать: загрузка не должна ломаться из-за сжатия.
 */
async function shrinkImage(file:File):Promise<{blob:Blob;name:string;compressed:boolean}>{
  const plain={blob:file as Blob,name:file.name,compressed:false};
  if(!/^image\/(jpeg|png|webp)$/.test(file.type))return plain;
  if(file.size<=IMAGE_COMPRESS_ABOVE)return plain;
  let bitmap:ImageBitmap|null=null;
  try{
    bitmap=await createImageBitmap(file);
    const scale=Math.min(1,IMAGE_MAX_EDGE/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext("2d");
    if(!context)return plain;
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,"image/webp",IMAGE_QUALITY));
    if(!blob||blob.size>=file.size)return plain;
    return {blob,name:webpName(file.name),compressed:true};
  }catch{
    return plain;
  }finally{
    bitmap?.close();
  }
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

/**
 * Последний ход оборвался на запросе ключа. Сервер хранит такие запросы отдельно, но даже если
 * окно не восстановилось (перезапуск сервера, старая вкладка), при продолжении агенту нужно
 * сказать, какой ключ он просил: из истории вызов без результата вычищается как незавершённый.
 */
function interruptedSecretRequest(messages:ChatMessage[]):{variable:string;file:string}|null{
  // Результат мог сохраниться для другого вызова из того же хода: ищем именно неотвеченный
  // secrets.request, а не просто последнюю реплику.
  const answered=new Set(messages.flatMap(message=>message.role==="tool"?[message.tool_call_id]:[]));
  for(let index=messages.length-1;index>=0;index--){
    const message=messages[index];
    if(message.role!=="assistant")continue;
    const call=message.tool_calls?.find(item=>item.name==="secrets.request"&&!answered.has(item.id));
    if(!call)continue;
    const input=call.arguments as {variable?:unknown;file?:unknown};
    if(typeof input?.variable!=="string")continue;
    return {variable:input.variable,file:typeof input.file==="string"?input.file:".env.local"};
  }
  return null;
}

export function AgentPanel({projectId,conversationId,onChanged,onOpenModelSettings,onOpenAccountSettings,onRunningChange,onOpenChanges,scrollSignal,onChatEndChange,onScrollBottom,showScroll,writing}:{projectId:string;conversationId:string;onChanged:()=>void;onOpenModelSettings?:()=>void;onOpenAccountSettings?:()=>void;onRunningChange?:(running:boolean)=>void;onOpenChanges?:()=>void;scrollSignal?:number;onChatEndChange?:(atEnd:boolean)=>void;onScrollBottom?:()=>void;showScroll?:boolean;writing?:boolean}){
  const [messages,setMessages]=useState<ChatMessage[]>([]);
  const [prompt,setPrompt]=useState<string>(()=>readDraft(conversationId));
  const [running,setRunning]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [queue,setQueue]=useState<QueuedMessage[]>([]);
  const [attachments,setAttachments]=useState<Attachment[]>([]);
  // Файлы можно не только выбрать кнопкой, но и перетащить в поле ввода: это первый путь,
  // которым люди кидают фотографии в проект.
  const [dragActive,setDragActive]=useState(false);
  const [uploading,setUploading]=useState(false);
  const [notice,setNotice]=useState("");
  // Действия под ответом агента: копирование и отправка списка в TASKS.md. Состояние
  // привязано к номеру сообщения, чтобы нажатие не подсвечивало чужие ответы.
  const [copiedMessage,setCopiedMessage]=useState<number|null>(null);
  const [tasksMessage,setTasksMessage]=useState<number|null>(null);
  const copiedMessageTimer=useRef<number|null>(null);
  // Итог задачи в истории проекта: точка, к которой можно вернуться. На GitHub она уходит
  // только по кнопке в «Изменениях», поэтому здесь нет ни статуса отправки, ни ошибки.
  const [changesNotice,setChangesNotice]=useState<{shortSha:string}|null>(null);
  // The plan and the actions of the latest run are what the user watches while the
  // agent works, so they live here next to the messages.
  const [mode,setMode]=useState<AgentMode>(readStoredMode);
  const [reasoning,setReasoning]=useState<ReasoningEffort>(readStoredReasoning);
  const [webSearch,setWebSearch]=useState<boolean>(readStoredWebSearch);
  const [modelInfo,setModelInfo]=useState<ModelInfo|null>(null);
  // Поддержка глубины размышления у выбранной модели: если шлюз её не принимает, выбор глубины
  // не показывается — переключатель, который ничего не меняет, хуже его отсутствия.
  const [reasoningSupport,setReasoningSupport]=useState<ReasoningSupport|null>(null);
  const [plan,setPlan]=useState<PlanState|null>(()=>readPlan(conversationId));
  const [actions,setActions]=useState<AgentAction[]>([]);
  const [panels,setPanels]=useState<PanelState>(readPanelState);
  // Действия живут в доке под полем ввода: открытость — его собственное состояние, а не
  // запомненное свёрнутое состояние панели.
  const [actionsOpen,setActionsOpen]=useState(false);
  const actionsDockRef=useRef<HTMLDivElement|null>(null);
  const [progress,setProgress]=useState<{step:number;maxSteps:number;tokens?:number;budget?:number}|null>(null);
  /**
   * Запрос ключа от агента. Само значение живёт только в этом состоянии до отправки и уходит прямо
   * в песочницу проекта: оно не попадает ни в переписку, ни в события, ни в ответы модели.
   */
  const [secretPrompt,setSecretPrompt]=useState<SecretPrompt|null>(null);
  const [secretValue,setSecretValue]=useState("");
  const [secretBusy,setSecretBusy]=useState(false);
  const [secretError,setSecretError]=useState("");
  /** Доступ к облаку, регистратору, сервису или базе — карточка с полями того же кабинета. */
  const [accessPrompt,setAccessPrompt]=useState<AccessPrompt|null>(null);
  const [accessValues,setAccessValues]=useState<Record<string,string>>({});
  const [accessVisible,setAccessVisible]=useState<Record<string,boolean>>({});
  const [accessWrites,setAccessWrites]=useState(true);
  const [accessBusy,setAccessBusy]=useState(false);
  const [accessError,setAccessError]=useState("");
  // Показать значение можно только на время: окно закрывается — режим показа сбрасывается,
  // чтобы следующий запрос не открывался с открытым ключом.
  const [secretVisible,setSecretVisible]=useState(false);
  /**
   * Вопрос агента, который ждёт выбора. Окно живёт над полем ввода: варианты готовые, но всегда
   * можно написать свой. Запуск в это время стоит и продолжается сразу после ответа.
   */
  const [questionPrompt,setQuestionPrompt]=useState<AgentQuestion|null>(null);
  const [questionBusy,setQuestionBusy]=useState(false);
  const [questionError,setQuestionError]=useState("");
  const [quotaNotice,setQuotaNotice]=useState<"storage"|"daily"|"tokens"|null>(null);
  // The project's saved chats. The list comes from the server, so a chat is something
  // the user can return to from another device, not just from this browser.
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
  /**
   * Строка «провайдер просил подождать — жду и продолжаю» сейчас на экране. Она живёт только до
   * первого признака настоящей работы: пока агент ждёт лимит, панель не должна выглядеть как ошибка.
   */
  const retryNoticeRef=useRef(false);
  /**
   * Что стало с окном ключа, восстановленным после перезагрузки: его сохранили или пропустили.
   * Кнопка «Продолжить» передаёт это модели, чтобы она не запрашивала тот же ключ снова.
   */
  const recoveredSecretRef=useRef<{variable:string;file:string;status:"saved"|"skipped"}|null>(null);
  // Список сообщений: открытие проекта начинается с самого верха переписки, а не с её конца, и
  // ответ работающего агента остаётся в поле зрения, пока пользователь у нижнего края.
  const messagesBoxRef=useRef<HTMLDivElement|null>(null);
  /**
   * Пользователь у нижнего края переписки: только тогда новые сообщения подхватываются сами.
   * Открытый чат стоит в начале, поэтому сразу после входа это false — иначе первый же ответ агента
   * утащил бы список вниз, и проект снова открывался бы с конца чата.
   */
  const pinnedToEndRef=useRef(false);
  /**
   * Кнопка «вниз» в строке вкладок должна знать, осталось ли что-то ниже: колбэк хранится в ref,
   * чтобы измерение не переподписывало обработчик прокрутки на каждом рендере родителя.
   */
  const chatEndRef=useRef(onChatEndChange);
  chatEndRef.current=onChatEndChange;
  const autoResumeTimerRef=useRef<number|null>(null);
  /** Показанный запрос, к которому сейчас ведёт закладка: строка подсвечивается на пару секунд. */
  const [jumpedIndex,setJumpedIndex]=useState<number|null>(null);
  const jumpTimerRef=useRef<number|null>(null);
  // Queued messages start runs from socket callbacks, so the mode is read from a ref.
  const modeRef=useRef<AgentMode>(mode);
  const reasoningRef=useRef<ReasoningEffort>(reasoning);
  // Очередь и переподключение запускают запуск из колбеков сокета, поэтому флаг читается из ref.
  const webSearchRef=useRef<boolean>(webSearch);
  /** A queued template/import start is consumed once per conversation, never twice. */
  const pendingStartRef=useRef<string|null>(null);
  const fileRef=useRef<HTMLInputElement|null>(null);
  // The socket callbacks and the queue drain start new runs, so they read the latest
  // conversation and queue from refs instead of the render they were created in.
  const messagesRef=useRef<ChatMessage[]>([]);
  const queueRef=useRef<QueuedMessage[]>([]);
  // Чат, которому принадлежит текст в поле: по нему панель отличает «пользователь печатает»
  // от «открыт другой чат, и текст надо взять из его черновика».
  const draftOwnerRef=useRef(conversationId);

  useEffect(()=>{queueRef.current=queue},[queue]);

  // Запуск сообщается наверх: рабочая область и главная по этому признаку знают, что агент
  // продолжает работать над проектом, даже когда панель не на экране.
  useEffect(()=>{onRunningChange?.(running)},[running,onRunningChange]);

  // Черновик сохраняется на каждое нажатие, поэтому текст переживает перезагрузку страницы.
  // Эффект стоит перед эффектом переключения чата: черновик уходит под ключ того чата, в котором
  // текст набран, и не переезжает в открытый следом.
  useEffect(()=>{
    if(draftOwnerRef.current!==conversationId)return;
    writeDraft(conversationId,prompt);
  },[prompt,conversationId]);

  // Открыт другой чат: прежний текст уже лежит в его черновике, а поле показывает черновик нового.
  useEffect(()=>{
    if(draftOwnerRef.current===conversationId)return;
    draftOwnerRef.current=conversationId;
    setPrompt(readDraft(conversationId));
  },[conversationId]);

  function updateMessages(updater:(current:ChatMessage[])=>ChatMessage[]){
    messagesRef.current=updater(messagesRef.current);
    setMessages(messagesRef.current);
  }

  /**
   * Прокрутка нужна только тому, кто читает последнее. Если человек отлистал переписку вверх
   * (читать историю), панель его не выдёргивает обратно на каждый ответ агента.
   */
  function trackMessagesScroll(){
    const box=messagesBoxRef.current;
    if(!box)return;
    pinnedToEndRef.current=box.scrollHeight-box.scrollTop-box.clientHeight<120;
    chatEndRef.current?.(pinnedToEndRef.current);
  }

  /**
   * Мгновенный переход к концу переписки из-под правой рельсы: без плавной прокрутки, сразу к
   * последнему сообщению, и автопрокрутка снова включается — дальше ответы идут в поле зрения.
   */
  useEffect(()=>{
    if(!scrollSignal)return;
    const box=messagesBoxRef.current;
    if(!box)return;
    pinnedToEndRef.current=true;
    box.scrollTop=box.scrollHeight;
    setJumpedIndex(null);
    chatEndRef.current?.(true);
  },[scrollSignal]);

  // Открытая переписка стоит на самом начале и не выделяет прокрутку, поэтому положение
  // измеряется после загрузки: иначе кнопка «вниз» не появилась бы над длинной историей.
  useEffect(()=>{
    if(!loaded)return;
    const timer=window.setTimeout(()=>{
      const box=messagesBoxRef.current;
      if(!box)return;
      chatEndRef.current?.(box.scrollHeight-box.scrollTop-box.clientHeight<120);
    },0);
    return ()=>window.clearTimeout(timer);
  },[loaded,conversationId]);

  /** Прокрутка к началу: у открытого проекта первым видно самое раннее сообщение переписки. */
  function scrollMessagesToTop(){
    const box=messagesBoxRef.current;
    if(box)box.scrollTop=0;
  }

  /**
   * Переход к запросу из закладки. Строка ставится к верхнему краю переписки и подсвечивается на
   * пару секунд: иначе после плавной прокрутки не видно, что нашлось. Автопрокрутка при этом
   * отключается, иначе следующий ответ агента увёл бы чат обратно вниз.
   */
  function jumpToMessage(index:number){
    const box=messagesBoxRef.current;
    if(!box)return;
    const row=box.querySelector<HTMLElement>('[data-message-index="'+index+'"]');
    if(!row)return;
    pinnedToEndRef.current=false;
    chatEndRef.current?.(false);
    box.scrollTo({top:box.scrollTop+row.getBoundingClientRect().top-box.getBoundingClientRect().top-12,behavior:"smooth"});
    setJumpedIndex(index);
    if(jumpTimerRef.current)window.clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current=window.setTimeout(()=>setJumpedIndex(null),1600);
  }

  /**
   * Новые сообщения показываются сразу, но только тому, кто читает последнее. Открытый чат стоит
   * в начале, поэтому ответ агента не сдвигает список, пока пользователь сам не ушёл вниз или не
   * отправил сообщение.
   */
  useEffect(()=>{
    const box=messagesBoxRef.current;
    if(!box||!pinnedToEndRef.current)return;
    box.scrollTop=box.scrollHeight;
    chatEndRef.current?.(true);
  },[messages,loaded]);

  function replaceMessages(next:ChatMessage[]){
    messagesRef.current=next;
    setMessages(next);
  }

  function updateActions(updater:(current:AgentAction[])=>AgentAction[]){
    actionsRef.current=updater(actionsRef.current);
    setActions(actionsRef.current);
  }

  // Док действий закрывается нажатием в любом месте вне него и по Escape: развёрнутый список —
  // это поповер, а не панель, которую нужно убирать только стрелкой.
  useEffect(()=>{
    if(!actionsOpen)return;
    const onPointer=(event:PointerEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(target&&actionsDockRef.current?.contains(target))return;
      setActionsOpen(false);
    };
    const onKey=(event:KeyboardEvent)=>{if(event.key==="Escape")setActionsOpen(false)};
    document.addEventListener("pointerdown",onPointer,true);
    window.addEventListener("keydown",onKey);
    return ()=>{
      document.removeEventListener("pointerdown",onPointer,true);
      window.removeEventListener("keydown",onKey);
    };
  },[actionsOpen]);

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

  function chooseReasoning(next:ReasoningEffort){
    reasoningRef.current=next;
    setReasoning(next);
    try{localStorage.setItem(reasoningKey,next)}catch{}
  }

  /** Кнопка поиска: включает и выключает выход агента в интернет на следующие запуски. */
  function chooseWebSearch(next:boolean){
    webSearchRef.current=next;
    setWebSearch(next);
    try{localStorage.setItem(webSearchKey,next?"on":"off")}catch{}
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

  /** Ожидание лимита провайдера кончилось: строка «жду … с» уходит вместе с ним. */
  function clearRetryNotice(){
    if(!retryNoticeRef.current)return;
    retryNoticeRef.current=false;
    setNotice("");
  }

  /**
   * Окно ключа закрывается при смене чата или отмене. Запрос, переживший перезагрузку, не
   * теряется: сервер отдаёт его при открытии чата, а значение можно сохранить и продолжить.
   * Введённое значение очищается всегда — в поле оно не хранится.
   */
  function clearSecretPrompt(){
    setSecretPrompt(null);
    setSecretVisible(false);
    setSecretValue("");
    setSecretError("");
    setSecretBusy(false);
  }

  /** Карточка доступа закрывается вместе с запуском; значения не остаются в состоянии. */
  function clearAccessPrompt(){
    setAccessPrompt(null);
    setAccessValues({});
    setAccessVisible({});
    setAccessError("");
    setAccessBusy(false);
  }

  /**
   * Окно вопроса закрывается вместе со своим запуском: ответ, отправленный в закрытое окно, всё
   * равно некому прочитать, а висящий вопрос над полем выглядит как будто агент ещё ждёт.
   */
  function clearQuestionPrompt(){
    setQuestionPrompt(null);
    setQuestionError("");
    setQuestionBusy(false);
  }

  useEffect(()=>()=>{
    cancelAutoResume();
    if(jumpTimerRef.current)window.clearTimeout(jumpTimerRef.current);
    if(copiedMessageTimer.current)window.clearTimeout(copiedMessageTimer.current);
  },[]);

  /** A cancelled or aborted run leaves rows spinning, so they are settled as failed. */
  function settleActions(){
    updateActions(current=>current.map(action=>action.status==="running"?{...action,status:"failed" as const,durationMs:Date.now()-action.startedAt}:action));
  }

  useEffect(()=>{
    let cancelled=false;
    setLoaded(false);
    queueRef.current=[];setQueue([]);
    setAttachments([]);setNotice("");
    // Итог прошлой задачи принадлежит прошлому чату: в другом разговоре он не про эту работу.
    setChangesNotice(null);
    retryNoticeRef.current=false;
    // Другой чат — с самого верха: место прокрутки прошлой переписки к новой не относится.
    pinnedToEndRef.current=false;
    scrollMessagesToTop();
    cancelAutoResume();
    autoResumeRef.current=0;setReconnect(null);setResume(null);closedByUsRef.current=true;
    actionsRef.current=[];setActions([]);setProgress(null);
    setPlan(readPlan(conversationId));
    // Запрос ключа и вопрос принадлежат запуску в этом чате: при открытии другого окна устаревают.
    recoveredSecretRef.current=null;
    clearSecretPrompt();
    clearAccessPrompt();
    clearQuestionPrompt();
    void Promise.all([
      getConversation(conversationId),
      // Запрос ключа мог остаться от запуска, прерванного перезагрузкой: сервер отдаёт его ещё
      // некоторое время, чтобы поле исчезало не вместе со страницей, а только после ответа.
      listPendingProjectSecrets(projectId,conversationId).catch(()=>({requests:[] as PendingProjectSecret[]})),
    ]).then(([conversation,pendingSecrets])=>{
      if(cancelled)return;
      // The whole stored history comes back: answers, the thinking that now sits above each of them
      // and the tool results that say how each action ended.
      const persisted=Array.isArray(conversation.messages)?conversation.messages:[];
      // Пустой чат остаётся пустым: задача начинается на главной или с шаблона, и
      // приветственная реплика над полем ввода только занимала место.
      replaceMessages(persisted);
      actionsRef.current=deriveActions(persisted);
      setActions(actionsRef.current);
      // The plan is stored with the conversation; localStorage is only the fallback.
      setPlan(conversation.plan??readPlan(conversationId));
      // Окно ключа возвращается в тот же чат: значение не потеряно, и его можно сохранить.
      const recoveredSecret=pendingSecrets.requests[0];
      if(recoveredSecret){
        setSecretPrompt({
          requestId:recoveredSecret.id,
          variable:recoveredSecret.variable,
          purpose:recoveredSecret.purpose,
          file:recoveredSecret.file,
          recovered:!recoveredSecret.waiting,
        });
        setSecretValue("");setSecretError("");
      }
      // Диалог, в котором запуск не дошёл до ответа, открывается сразу с кнопкой «Продолжить».
      setResume(recoveredSecret&&!recoveredSecret.waiting
        ? {reason:"запрос ключа остался без ответа после перезагрузки",label:"Ключ запрошен до перезагрузки — сохраните его и продолжите запуск."}
        : interruptedRun(persisted));
      setLoaded(true);
    }).catch(()=>{
      if(cancelled)return;
      replaceMessages([{role:"assistant",content:"Не удалось загрузить историю этой сессии."}]);
      setLoaded(true);
    });
    return()=>{cancelled=true;socketRef.current?.close();socketRef.current=null};
  },[conversationId,projectId]);

  /**
   * Шаблон и импорт GitHub ставят задачу до открытия рабочей области. Здесь она забирается один раз:
   * агент переключается в планировщик и сам начинает разговор с уточняющих вопросов, а не ждёт,
   * пока человек напишет то же самое ещё раз.
   */
  useEffect(()=>{
    if(!loaded||running||pendingStartRef.current===conversationId)return;
    const pending=takeAgentStart(conversationId);
    if(!pending)return;
    pendingStartRef.current=conversationId;
    chooseMode("planner");
    startRun({text:pending.prompt,attachments:[]});
  },[loaded,conversationId,running]);

  /**
   * Задача из другой панели — сейчас это кнопка «Собрать тему» в предпросмотре. Очередь и запуск
   * те же, что у кнопки отправки: пока агент работает, сообщение встаёт в очередь и не теряется.
   * Обработчик держится в ref: событие не должно переподписываться на каждый рендер панели.
   */
  const composeRef=useRef<(text:string)=>void>(()=>{});
  composeRef.current=text=>{
    const item:QueuedMessage={id:nextId(),text,attachments:[]};
    if(running){queueRef.current=[...queueRef.current,item];setQueue(queueRef.current);return}
    chooseMode("developer");
    startRun(item);
  };
  useEffect(()=>{
    const onCompose=(event:Event)=>{
      const detail=(event as CustomEvent<{prompt?:unknown}>).detail;
      const text=typeof detail?.prompt==="string"?detail.prompt.trim():"";
      if(text)composeRef.current(text);
    };
    window.addEventListener(AGENT_COMPOSE_EVENT,onCompose);
    return ()=>window.removeEventListener(AGENT_COMPOSE_EVENT,onCompose);
  },[]);

  /**
   * Описание элемента из предпросмотра кладётся в поле ввода, а не отправляется: просьбу
   * («крупнее», «в акцентный цвет») человек дописывает сам. Курсор ставится в конец — сразу после
   * «Что сделать:».
   */
  const promptBoxRef=useRef<HTMLTextAreaElement|null>(null);
  const draftRef=useRef<(text:string)=>void>(()=>{});
  draftRef.current=text=>{
    setPrompt(current=>{
      const existing=current.trim();
      return existing?existing+"\n\n"+text:text;
    });
    window.requestAnimationFrame(()=>{
      const box=promptBoxRef.current;
      if(!box)return;
      box.focus();
      box.selectionStart=box.selectionEnd=box.value.length;
    });
  };
  useEffect(()=>{
    const onDraft=(event:Event)=>{
      const detail=(event as CustomEvent<{draft?:unknown}>).detail;
      const text=typeof detail?.draft==="string"?detail.draft.trim():"";
      if(text)draftRef.current(text);
    };
    window.addEventListener(AGENT_DRAFT_EVENT,onDraft);
    return ()=>window.removeEventListener(AGENT_DRAFT_EVENT,onDraft);
  },[]);

  // The model is a project setting, so the composer reads it instead of assuming one;
  // it shows the same model the runtime picks: the project one, or the platform default.
  useEffect(()=>{
    let cancelled=false;
    setModelInfo(null);
    void apiJson<ProviderStatus>(`/api/projects/${encodeURIComponent(projectId)}/provider`).then(status=>{
      if(cancelled)return;
      setReasoningSupport(status.reasoning??null);
      if(status.configured)setModelInfo({model:status.model,provider:status.provider,source:"project"});
      else if(status.platformDefault?.available)setModelInfo({model:status.platformDefault.model,provider:status.platformDefault.providerName,source:"platform",freeModel:status.platformDefault.freeModel===true});
      else setModelInfo({model:"",provider:"",source:"none"});
    }).catch(()=>{if(!cancelled)setModelInfo({model:"",provider:"",source:"unknown"})});
    return()=>{cancelled=true};
  },[projectId]);

  /**
   * Перечитывает наблюдение о глубине размышления. Запуск — тоже проверка: если шлюз отклонил
   * `reasoning_effort`, выбор глубины должен исчезнуть сразу, а не после перезагрузки панели.
   */
  function refreshReasoningSupport(){
    void apiJson<ProviderStatus>(`/api/projects/${encodeURIComponent(projectId)}/provider`)
      .then(status=>setReasoningSupport(status.reasoning??null))
      .catch(()=>{});
  }

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
    // Новая задача — новый итог: прошлая точка уже в истории, и напоминание о ней не нужно.
    setChangesNotice(null);
    // Отправленное сообщение и ответ на него — то, что хочется видеть, даже если до этого
    // переписка была отлистана вверх.
    pinnedToEndRef.current=true;
    // При автопереподключении строка «переподключаюсь…» остаётся видимой до открытия сокета: панель
    // не должна выглядеть бездействующей, пока идёт повторная попытка.
    if(!resuming)setReconnect(null);
    updateActions(()=>[]);
    setProgress(null);
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
      // Строка ожидания снимается первым же признаком работы: ответом, размышлением или действием.
      if(RETRY_NOTICE_CLEAR_EVENTS.has(event.type))clearRetryNotice();
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
        // Признак начатого запуска снимает и сам факт ожидания: строка очереди и строка лимита
        // провайдера делят одно место, а ссылка не должна пережить показанную строку.
        if(event.type==="run.started")retryNoticeRef.current=false;
        setNotice(event.type==="run.queued"?"Сервер занят другим запуском — вы в очереди"+(typeof event.queued==="number"&&event.queued>0?" (впереди: "+event.queued+")":"")+"…":"");
      }
      if(event.type==="run.progress"&&typeof event.step==="number"&&typeof event.maxSteps==="number")setProgress({step:event.step,maxSteps:event.maxSteps,...(typeof event.tokens==="number"?{tokens:event.tokens}:{}),...(typeof event.budget==="number"?{budget:event.budget}:{})});
      // Провайдер ответил «подожди»: запуск не прерывается, шаг ждёт и повторяется сам. Пользователь
      // видит это строкой над полем ввода, а не ошибкой в переписке.
      if(event.type==="run.retrying"){
        const wait=typeof event.waitSeconds==="number"&&event.waitSeconds>0?event.waitSeconds:1;
        const reason=event.code==="RATE_LIMIT"?"Провайдер ограничил частоту запросов":event.code==="NETWORK"?"Связь с провайдером прервалась":"Провайдер временно недоступен";
        retryNoticeRef.current=true;
        setNotice(reason+" — жду "+wait+" с и продолжаю (попытка "+event.attempt+" из "+event.attempts+")…");
      }
      if(event.type==="tool.started"&&event.name){
        const name=event.name;
        const id=event.toolCallId??nextId();
        // Publishing the plan already updates the plan card, so it is not repeated here.
        if(name!=="plan.update")updateActions(current=>{
          const before=contentBefore(current,name,event.input);
          return [...current,{id,name,target:actionTarget(name,event.input).slice(0,160),status:"running",startedAt:Date.now(),input:event.input,...(before!==undefined?{before}:{})}];
        });
      }
      if(event.type==="tool.finished"&&event.name){
        const id=event.toolCallId??"";
        const output=event.output as {error?:unknown;ok?:unknown}|null;
        const failed=Boolean(output&&typeof output==="object"&&(("error" in output&&output.error)||output.ok===false));
        updateActions(current=>current.map(action=>action.id===id?{...action,status:failed?"failed":"done",durationMs:Date.now()-action.startedAt,output:event.output}:action));
      }
      if(event.type==="plan.updated"&&event.plan)updatePlan(event.plan);
      if(event.type==="secret.requested"&&event.requestId&&event.variable){
        // Агент просит ключ: карточка в чате показывает только имя переменной, файл и причину;
        // значение вводит пользователь, и в переписку оно не попадает.
        recoveredSecretRef.current=null;
        setSecretPrompt({requestId:event.requestId,variable:event.variable,purpose:event.purpose??"",file:event.file??".env.local"});
        setSecretValue("");setSecretError("");
      }
      if(event.type==="access.requested"&&event.requestId&&event.name&&event.fields?.length){
        // Поля провайдера — в чате, а не в модальном окне поверх переписки: человек видит,
        // какой шаг ждёт, и после сохранения агент продолжает сам.
        setAccessPrompt({
          requestId:event.requestId,
          kind:event.kind??"cloud",
          provider:event.provider??"",
          name:event.name,
          purpose:event.purpose??"Агент просит доступ, чтобы продолжить развёртывание.",
          fields:event.fields,
          steps:event.steps??[],
          ...(event.keyUrl?{keyUrl:event.keyUrl}:{}),
          ...(event.docsUrl?{docsUrl:event.docsUrl}:{}),
          verificationNote:event.verificationNote??"",
          writes:Boolean(event.writes),
          defaultAllowWrites:event.defaultAllowWrites!==false,
        });
        setAccessValues({});setAccessVisible({});setAccessError("");setAccessBusy(false);
        setAccessWrites(event.defaultAllowWrites!==false);
      }
      if(event.type==="question.asked"&&event.requestId&&event.question&&event.options?.length){
        // Агент спрашивает о выборе: окно выезжает над полем ввода, а запуск стоит и ждёт ответа.
        setQuestionPrompt({
          requestId:event.requestId,question:event.question,options:event.options,
          multiSelect:Boolean(event.multiSelect),
          ...(event.maxSelections===undefined?{}:{maxSelections:event.maxSelections}),
          allowCustom:event.allowCustom!==false,
        });
        setQuestionError("");setQuestionBusy(false);
      }
      if(event.type==="changes.created"&&event.checkpoint){
        // Задача записана в историю проекта. Отправка на GitHub — только по кнопке пользователя.
        setChangesNotice({shortSha:event.checkpoint.shortSha});
      }
      if(event.type==="run.completed"){completedRef.current=true;endRun(socket,{drain:true});onChanged();refreshReasoningSupport()}
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
        // Пул токенов тарифа: сброс не сегодня, а с первого числа месяца, поэтому подсказка другая.
        const isTokenBudget = event.code === "TOKEN_BUDGET_EXHAUSTED";
        // The server is at its parallel-run limit: the queue was full or the wait ran out.
        const isBusy = event.code === "SERVER_BUSY";
        // One account runs one agent at a time, so a second tab or project is turned away.
        const isAccountBusy = event.code === "RUN_ALREADY_ACTIVE";
        const quotaKind = isStorageLimit ? "storage" : isTokenBudget ? "tokens" : isDailyQuota ? "daily" : null;
        updateMessages(current=>[...current,{role:"assistant",content:(quotaKind==="storage"?"Достигнут лимит хранилища вашего тарифа. ":quotaKind==="tokens"?"Месячный пул токенов тарифа исчерпан. ":quotaKind==="daily"?"Дневной лимит запусков агента исчерпан. ":isAccountBusy?"Агент уже работает в этом аккаунте. ":isBusy?"Сервер занят. ":"Ошибка: ")+errorMsg}]);
        if(quotaKind)setQuotaNotice(quotaKind);
        // Тариф и очередь аккаунта требуют не «Продолжить», а действия с тарифом или ожидания: у этих
        // отказов запуск даже не начался, и кнопка продолжения только запутала бы.
        const resumable=!quotaKind&&!isAccountBusy;
        endRun(socket,{drain:false,notice:quotaKind==="storage"?"Хранилище заполнено — обновите тариф":quotaKind==="tokens"?"Пул токенов на месяц исчерпан":quotaKind==="daily"?"Дневной лимит исчерпан":isAccountBusy?"Агент уже работает в этом аккаунте — дождитесь завершения или остановите его":isBusy?"Сервер занят — повторите запуск позже":"Запуск остановлен",...(resumable?{resume:{reason:"запуск был отклонён сервером: "+errorMsg.slice(0,160),label:"Запуск остановлен — агент продолжит с того же места."}}:{})});
      }
    },()=>drop());
      socketRef.current=socket;
      // Обрыв виден и как ошибка, и как закрытие: сервер отдаёт "connection closed before
      // receiving a handshake response" без ошибки, поэтому считаем и close.
      socket.addEventListener("close",()=>drop());
      socket.addEventListener("open",()=>{
        opened=true;
        setReconnect(null);
        socket.send(JSON.stringify({type:"agent.run",request:{projectId,conversationId,messages:history,mode:modeRef.current,reasoning:reasoningRef.current,webSearch:webSearchRef.current,...(resuming?{resume:{reason:options.resumeReason}}:{})}}));
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
        // Ожидание лимита оборвалось вместе с соединением: следующее уведомление своё.
        retryNoticeRef.current=false;
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
          clearSecretPrompt();
          clearAccessPrompt();
          clearQuestionPrompt();
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
    // Запуск кончился — окна ключа, доступа и вопроса закрываются вместе с ним: запросы уже неактуальны.
    clearSecretPrompt();
    clearAccessPrompt();
    clearQuestionPrompt();
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
    clearSecretPrompt();
    clearAccessPrompt();
    clearQuestionPrompt();
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
    // Окно ключа от прерванного запуска могло остаться без ответа. Если человек нажал
    // «Продолжить», не сохранив значение, модель должна запросить ключ снова: из истории
    // незавершённый вызов инструмента вычищается как не имеющий результата.
    const recovered=recoveredSecretRef.current;
    const secret=secretPrompt??interruptedSecretRequest(messagesRef.current);
    // Причина сервера ограничена 300 символами, а имя переменной и файл уже занимают место.
    // Продолжение и так помечено сервером как resume, поэтому в этом случае говорит только ключ.
    const reason=recovered
      ? (recovered.status==="saved"
        ? "ключ "+recovered.variable+" уже сохранён пользователем в "+recovered.file+": используй process.env и не запрашивай его снова"
        : "ключ "+recovered.variable+" пропущен пользователем: не запрашивай его снова и продолжи без него")
      : secret
        ? "ключ "+secret.variable+" так и не сохранён: запроси его снова через secrets.request"
        : resume.reason;
    startRun(null,{resumeReason:reason});
    recoveredSecretRef.current=null;
  }

  /** Остановка другим сообщением: кнопка продолжения относилась бы к уже заменённому запуску. */
  function interruptForNewRun(){
    if(running)interrupt({resume:false});
  }

  /**
   * Подтверждение плана — это и есть команда агенту: кнопка переводит его из планировщика в
   * разработчика и отправляет утверждённый список шагов следующим сообщением. Пока агент работает
   * или плана нет, кнопка недоступна, поэтому случайно переключить режим нельзя.
   */
  function approvePlan(){
    if(!plan||!plan.items.length||running)return;
    const steps=plan.items.map((item,index)=>(index+1)+". "+item.title+(item.note?" — "+item.note:"")).join("\n");
    chooseMode("developer");
    startRun({text:"План утверждён. Переключаюсь в режим разработчика: выполни утверждённый план по шагам, отмечай прогресс через plan.update и проверь результат.\n\n"+steps,attachments:[]});
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

  /**
   * Значение ключа уходит отдельным запросом прямо в песочницу проекта: агент получает только
   * подтверждение. Поэтому оно не появляется ни в переписке, ни в событиях запуска.
   */
  async function saveSecret(){
    const prompt=secretPrompt;
    if(!prompt||secretBusy||!secretValue.trim())return;
    const value=secretValue;
    setSecretBusy(true);setSecretError("");
    try{
      const result=await submitProjectSecret(projectId,prompt.requestId,value);
      clearSecretPrompt();
      if(result.delivered===false){
        // Запуск, который ждал ключ, уже остановлен перезагрузкой: значение сохранено, но
        // продолжить его должен человек кнопкой — сама панель новый запуск не начинает.
        recoveredSecretRef.current={variable:prompt.variable,file:prompt.file,status:"saved"};
        setResume({reason:"ключ сохранён после перезагрузки",label:"Ключ сохранён — продолжите запуск."});
        setNotice("Ключ сохранён в "+prompt.file+". Запуск, который ждал ключ, уже остановлен — нажмите «Продолжить».");
      }else{
        setNotice("Ключ сохранён в "+prompt.file+" — агент продолжает работу, не видя значения.");
      }
    }catch(error){
      setSecretError(error instanceof Error?error.message:"Не удалось сохранить ключ");
    }finally{
      // Значение не остаётся в поле даже после ошибки: повторный ввод дешевле утечки.
      setSecretValue("");setSecretBusy(false);
    }
  }

  /** Отмена: агент получает отказ и продолжает без ключа, а не ждёт до таймаута. */
  async function cancelSecret(){
    const prompt=secretPrompt;
    if(!prompt)return;
    clearSecretPrompt();
    if(prompt.recovered){
      recoveredSecretRef.current={variable:prompt.variable,file:prompt.file,status:"skipped"};
      setResume({reason:"запрос ключа закрыт после перезагрузки",label:"Запрос ключа закрыт — можно продолжить запуск."});
    }
    try{await cancelProjectSecret(projectId,prompt.requestId)}catch{}
  }

  /**
   * Доступ уходит на сервер тем же путём, что и карточка интеграции: поля проверяются у
   * провайдера, сохраняются зашифрованными, а агенту возвращается только подтверждение.
   * Ошибка проверки оставляет карточку открытой — человек исправит поле, не начиная заново.
   */
  async function saveAccess(){
    const prompt=accessPrompt;
    if(!prompt||accessBusy)return;
    const missing=prompt.fields.find(field=>!field.optional&&!accessValues[field.key]?.trim());
    if(missing){setAccessError("Заполните поле «"+missing.label+"»");return;}
    setAccessBusy(true);setAccessError("");
    try{
      const values=Object.fromEntries(prompt.fields.map(field=>[field.key,(accessValues[field.key]??"").trim()]));
      const saved=await submitProjectAccess(projectId,prompt.requestId,values,prompt.writes?accessWrites:undefined);
      setAccessPrompt(null);
      setAccessValues({});
      setAccessVisible({});
      setNotice(saved.delivered
        ?"Доступ к "+prompt.name+" сохранён — агент продолжает работу."
        :"Доступ к "+prompt.name+" сохранён, но запуск уже завершился. Нажмите «Продолжить», чтобы агент пошёл дальше.");
    }catch(error){
      setAccessError(error instanceof Error?error.message:"Не удалось сохранить доступ");
    }finally{setAccessBusy(false)}
  }

  /** Отказ от доступа: агент узнаёт сразу и продолжает с тем, что уже есть. */
  async function cancelAccess(){
    const prompt=accessPrompt;
    if(!prompt)return;
    clearAccessPrompt();
    try{await cancelProjectAccess(projectId,prompt.requestId)}catch{}
  }

  /**
   * Ответ на вопрос агента уходит отдельным запросом: запуск уже открыт и ждёт ровно этот ответ,
   * поэтому окно закрывается только после подтверждения сервера, а ошибка остаётся в окне.
   */
  async function answerQuestion(answer:{selected:string[];custom?:string}){
    const prompt=questionPrompt;
    if(!prompt||questionBusy)return;
    setQuestionBusy(true);setQuestionError("");
    try{
      await answerProjectQuestion(projectId,prompt.requestId,answer);
      setQuestionPrompt(null);
      setNotice("Ответ передан агенту — он продолжает работу.");
    }catch(error){
      setQuestionError(error instanceof Error?error.message:String(error));
    }finally{setQuestionBusy(false)}
  }

  /** Пропуск: агент получает отказ и выбирает разумный вариант сам, а не ждёт таймаута. */
  async function skipQuestion(){
    const prompt=questionPrompt;
    if(!prompt)return;
    clearQuestionPrompt();
    try{await skipProjectQuestion(projectId,prompt.requestId)}catch{}
  }

  async function pickFiles(files:FileList|null){
    if(!files?.length)return;
    setNotice("");
    setUploading(true);
    const uploaded:Attachment[]=[];
    const messages:string[]=[];
    let compressed=0;
    try{
      for(const file of Array.from(files)){
        try{
          const prepared=await shrinkImage(file);
          if(prepared.blob.size>MAX_UPLOAD_BYTES){
            messages.push(file.name+": больше "+formatBytes(MAX_UPLOAD_BYTES)+" — уменьшите файл перед загрузкой");
            continue;
          }
          const data=await readAsBase64(prepared.blob);
          const result=await uploadProjectFile(projectId,{name:prepared.name,data});
          if(prepared.compressed)compressed++;
          uploaded.push({id:result.path,name:result.name,path:result.path,bytes:result.bytes,image:prepared.blob.type.startsWith("image/")||/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(result.name)});
        }catch(error){
          messages.push(file.name+": "+(error instanceof Error?error.message:"не удалось загрузить"));
        }
      }
      if(uploaded.length)setAttachments(current=>[...current,...uploaded]);
      // О сжатии сообщаем: пользователь должен знать, почему файл в проекте называется .webp
      // и весит меньше, чем снимок на диске.
      if(compressed)messages.push("Фото уменьшены до "+IMAGE_MAX_EDGE+" px по длинной стороне — в проекте они легче, на вид те же");
      if(messages.length)setNotice(messages.join(" · "));
    }finally{
      setUploading(false);
      if(fileRef.current)fileRef.current.value="";
    }
  }

  /** Перетаскивание в поле ввода: тот же путь, что и кнопка «Прикрепить». */
  function dropFiles(event:ReactDragEvent){
    event.preventDefault();
    setDragActive(false);
    if(!loaded||uploading)return;
    void pickFiles(event.dataTransfer?.files??null);
  }

  // Gateway model ids carry a folder prefix (gpt://<folder>/<model>), so the chip shows
  // the model itself and the tooltip keeps the full id.
  // На бесплатном тарифе модель платформы — это цепочка бесплатной модели и её резерва.
  // Конкретное имя здесь показывать нельзя: от шага к шагу оно может меняться, а для человека
  // это один агент NestDev.
  const freeModel=modelInfo?.source==="platform"&&modelInfo.freeModel===true;
  const modelName=freeModel?"NestDev":modelInfo?modelInfo.model.split("/").pop()||"Модель не настроена":"Определяем модель…";
  const modelDetails=freeModel?"":[modelInfo?.provider,modelInfo?.model].filter(Boolean).join(" · ");
  const modelTitle=freeModel
    ?"Модель бесплатного тарифа. Чтобы выбрать модель, подключите свой AI-провайдер."
    :!modelInfo
      ?"Выбранная модель появится здесь"
      :modelInfo.model
        ?(modelInfo.source==="platform"?"Модель платформы":"Модель проекта")+": "+modelDetails+". Нажмите, чтобы открыть настройки AI-провайдера."
        :"AI-провайдер не настроен. Нажмите, чтобы указать Base URL и модель.";

  // Tool results are part of the stored history but not of the transcript; the action
  // list is built from them instead.
  const visibleMessages=messages.filter(message=>message.role!=="tool");
  // Служебный автозапуск (шаблон, импорт, знакомство) остаётся в истории для модели, но человек
  // видит только смысл — идею проекта или короткую подпись. В закладки такие сообщения не идут:
  // это не запросы пользователя, и метка на каждый автозапуск только путала бы навигацию.
  const shownUserMessage=(content:string)=>publicUserMessage(content);
  const bookmarks=visibleMessages.flatMap((message,index)=>{
    if(message.role!=="user")return [];
    const shown=shownUserMessage(message.content);
    return shown.internal?[]:[{index,text:shown.text}];
  });

  /** Копирование готового ответа: текст целиком, без обрезания по видимой области. */
  async function copyAnswer(index:number,content:string){
    const ok=await copyText(content);
    if(!ok){
      setNotice("Не удалось скопировать ответ — выделите текст вручную.");
      return;
    }
    setNotice("");
    setCopiedMessage(index);
    if(copiedMessageTimer.current)window.clearTimeout(copiedMessageTimer.current);
    copiedMessageTimer.current=window.setTimeout(()=>setCopiedMessage(null),1800);
  }

  /**
   * «В задачи» берёт из ответа только список дел: вступления, код и таблицы остаются в переписке.
   * Сервер сам отбрасывает дубли, поэтому повторное нажатие не плодит строки в TASKS.md.
   */
  async function answerToTasks(index:number,content:string){
    if(tasksMessage!==null)return;
    const items=parseTaskList(content);
    if(!items.length){
      setNotice("В этом ответе нет списка задач — добавьте пункт вручную во вкладке «Задачи».");
      return;
    }
    setTasksMessage(index);
    try{
      const result=await addProjectTasks(projectId,{items});
      const added=result.added;
      const word=added%10===1&&added%100!==11?"задача":added%10>=2&&added%10<=4&&(added%100<12||added%100>14)?"задачи":"задач";
      setNotice(added
        ?"Добавлено "+added+" "+word+" в TASKS.md"+(result.skipped?" · уже было: "+result.skipped:"")
        :"Эти задачи уже есть в TASKS.md.");
    }catch(error){
      setNotice("Не удалось добавить задачи: "+(error instanceof Error?error.message:String(error)));
    }finally{
      setTasksMessage(null);
    }
  }

  return <section className="chat">
    {/* Переписка и её закладки. Полоска закладок — рядом со скроллом, а не в нём: у каждой метки
        своя точка в переписке, и она должна оставаться на месте при прокрутке. */}
    <div className="messages-wrap">
    <div className="messages" ref={messagesBoxRef} onScroll={trackMessagesScroll}>
      {visibleMessages.map((m,i)=>{
        // Ответ, который модель пишет прямо сейчас: над ним идёт её размышление.
        const live=running&&i===visibleMessages.length-1;
        // Карточка ответа занимает ту же ширину, что «План задач» и «Действия агента»,
        // поэтому левый и правый края совпадают.
        return <div className={"message-row "+m.role+(jumpedIndex===i?" is-jumped":"")} key={i} data-message-index={i}>
          <div className="message-content">
            {/* Подпись автора осталась только у пользователя: над ответом агента ни имя, ни
                значок не нужны — карточка и так читается как ответ. */}
            {m.role==="user"&&<div className="message-role"><span>Вы</span></div>}
            {/* Размышление — над ответом, в своём контейнере, который можно свернуть и развернуть. */}
            {m.role==="assistant"&&(m.reasoning||live)&&<MessageThinking text={m.reasoning??""} running={live}/>}
            {m.role==="assistant"
              ? <div className="message-text markdown" onClick={openMarkdownLink}>{m.content
                  ? <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{m.content}</Markdown>
                  : running ? <NestLoader size={34} label="NestDev выполняет задачу" /> : ""}</div>
              : <div className="message-text">{shownUserMessage(m.content).text}</div>}
            {m.role==="assistant"&&m.content&&!live&&<div className="message-actions">
              <button className="message-action" onClick={()=>void copyAnswer(i,m.content)} title="Скопировать ответ целиком">
                {copiedMessage===i?<Check size={12}/>:<Copy size={12}/>}
                <span>{copiedMessage===i?"Скопировано":"Копировать"}</span>
              </button>
              <button className="message-action" onClick={()=>void answerToTasks(i,m.content)} disabled={tasksMessage!==null} title="Добавить список из ответа в TASKS.md — агент прочитает его по запросу">
                <ListPlus size={12}/>
                <span>{tasksMessage===i?"Добавляю…":"В задачи"}</span>
              </button>
            </div>}
          </div>
        </div>;
      })}

    </div>
    <ChatBookmarks
      containerRef={messagesBoxRef}
      items={bookmarks}
      onJump={jumpToMessage}
    />
    {/* Мгновенный возврат к концу переписки. Стоит внизу правой рельсы, по той же вертикали,
        что и её точки: не занимает место в строке вкладок и не перекрывает текст. */}
    {showScroll&&onScrollBottom&&<button type="button" className={"chat-scroll-bottom"+(writing?" is-live":"")} onClick={onScrollBottom} title="Мгновенно прокрутить переписку вниз" aria-label="Прокрутить переписку вниз">
      <ArrowDownToLine size={14}/>
      {writing&&<i className="chat-scroll-bottom-dot" aria-hidden="true"/>}
    </button>}
    </div>

    {/* Ключ и доступ — прямо в переписке, над полем ввода: агент остановился на этом шаге,
        и человек должен видеть, что именно он ждёт. Значения отсюда уходят только на сервер. */}
    {secretPrompt&&<section className="chat-credential" role="group" aria-labelledby="chat-secret-title">
      <header className="chat-credential-head">
        <span className="chat-credential-icon"><KeyRound size={15}/></span>
        <div className="chat-credential-title">
          <span className="eyebrow">КЛЮЧ ДЛЯ ПРОЕКТА</span>
          <strong id="chat-secret-title">{secretPrompt.variable}</strong>
        </div>
        <button type="button" className="icon-button" onClick={()=>void cancelSecret()} title="Отменить запрос" aria-label="Отменить запрос"><X size={14}/></button>
      </header>
      <p className="chat-credential-lead">{secretPrompt.purpose||"Агент просит ключ, чтобы продолжить работу над задачей."}</p>
      <div className="chat-credential-target"><KeyRound size={12}/><code>{secretPrompt.variable}</code><span>→ {secretPrompt.file}</span></div>
      <label className="secret-field">
        <span>Значение ключа</span>
        <input
          type={secretVisible?"text":"password"}
          autoFocus
          autoComplete="new-password"
          spellCheck={false}
          value={secretValue}
          onChange={event=>setSecretValue(event.target.value)}
          onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void saveSecret()}if(event.key==="Escape")void cancelSecret()}}
          placeholder="Вставьте значение — в чате оно не появится"
          aria-label={secretPrompt.variable}
        />
        <button type="button" className="secret-toggle" onClick={()=>setSecretVisible(value=>!value)} title={secretVisible?"Скрыть значение":"Показать значение"} aria-label={secretVisible?"Скрыть значение":"Показать значение"} tabIndex={-1}>{secretVisible?<EyeOff size={14}/>:<Eye size={14}/>}</button>
      </label>
      <p className="chat-credential-note"><ShieldCheck size={12}/><span>Значение попадает в зашифрованное хранилище проекта, а приложение получает его как <code>process.env</code>. Агент увидит только подтверждение.</span></p>
      {secretError&&<div className="connector-notice">{secretError}</div>}
      <footer className="chat-credential-actions">
        <span className="chat-credential-wait"><Sparkles size={11}/> {secretPrompt.recovered?"Запуск остановлен — сохраните ключ и нажмите «Продолжить»":"Агент ждёт и продолжит сам"}</span>
        <button type="button" className="ghost-button" onClick={()=>void cancelSecret()} disabled={secretBusy}>Пропустить</button>
        <button type="button" className="send-button chat-credential-save" onClick={()=>void saveSecret()} disabled={secretBusy||!secretValue.trim()}>{secretBusy?"Сохраняем…":secretPrompt.recovered?"Сохранить ключ":"Сохранить и продолжить"}</button>
      </footer>
    </section>}

    {accessPrompt&&<section className="chat-credential access-card" role="group" aria-labelledby="chat-access-title">
      <header className="chat-credential-head">
        <span className="chat-credential-icon access"><KeyRound size={15}/></span>
        <div className="chat-credential-title">
          <span className="eyebrow">ДОСТУП К ПРОВАЙДЕРУ</span>
          <strong id="chat-access-title">{accessPrompt.name}</strong>
        </div>
        <button type="button" className="icon-button" onClick={()=>void cancelAccess()} title="Отменить запрос" aria-label="Отменить запрос"><X size={14}/></button>
      </header>
      <p className="chat-credential-lead">{accessPrompt.purpose}</p>
      {accessPrompt.steps.length>0&&<ol className="access-steps">
        {accessPrompt.steps.map((step,index)=><li key={index}>{step}</li>)}
      </ol>}
      {(accessPrompt.keyUrl||accessPrompt.docsUrl)&&<div className="access-links">
        {accessPrompt.keyUrl&&<a href={accessPrompt.keyUrl} target="_blank" rel="noreferrer">Где взять ключ <ExternalLink size={10}/></a>}
        {accessPrompt.docsUrl&&<a href={accessPrompt.docsUrl} target="_blank" rel="noreferrer">Документация <ExternalLink size={10}/></a>}
      </div>}
      <div className="access-fields">
        {accessPrompt.fields.map(field=>{
          const secret=Boolean(field.secret);
          const visible=Boolean(accessVisible[field.key]);
          return <label className="access-field" key={field.key}>
            <span>{field.label}{field.optional&&<small>необязательно</small>}</span>
            {field.multiline
              ? <textarea
                  rows={4}
                  autoComplete="off"
                  spellCheck={false}
                  value={accessValues[field.key]??""}
                  onChange={event=>setAccessValues(current=>({...current,[field.key]:event.target.value}))}
                  placeholder={field.placeholder}
                  aria-label={field.label}
                />
              : <span className="access-input-wrap">
                  <input
                    type={secret&&!visible?"password":"text"}
                    autoComplete="off"
                    spellCheck={false}
                    value={accessValues[field.key]??""}
                    onChange={event=>setAccessValues(current=>({...current,[field.key]:event.target.value}))}
                    placeholder={field.placeholder}
                    aria-label={field.label}
                  />
                  {secret&&<button type="button" className="secret-toggle" onClick={()=>setAccessVisible(current=>({...current,[field.key]:!current[field.key]}))} title={visible?"Скрыть значение":"Показать значение"} aria-label={visible?"Скрыть значение":"Показать значение"} tabIndex={-1}>{visible?<EyeOff size={14}/>:<Eye size={14}/>}</button>}
                </span>}
          </label>;
        })}
      </div>
      {accessPrompt.writes&&<label className="access-writes">
        <input type="checkbox" checked={accessWrites} onChange={event=>setAccessWrites(event.target.checked)}/>
        <span><strong>Разрешить агенту изменять ресурсы</strong><small>Создание, настройка и удаление — только в рамках развёртывания и по явной просьбе.</small></span>
      </label>}
      <p className="chat-credential-note"><ShieldCheck size={12}/><span>{accessPrompt.verificationNote||"Поля сохраняются в зашифрованном хранилище интеграций и не возвращаются агенту."}</span></p>
      {accessError&&<div className="connector-notice">{accessError}</div>}
      <footer className="chat-credential-actions">
        <span className="chat-credential-wait"><Sparkles size={11}/> Агент ждёт и продолжит сам</span>
        <button type="button" className="ghost-button" onClick={()=>void cancelAccess()} disabled={accessBusy}>Отмена</button>
        <button type="button" className="send-button chat-credential-save" onClick={()=>void saveAccess()} disabled={accessBusy}>{accessBusy?"Проверяем…":"Сохранить и продолжить"}</button>
      </footer>
    </section>}

    {/* План и действия — у поля ввода: они относятся к тому, что происходит сейчас, и не должны
        уезжать вверх вместе с длинной перепиской. */}
    {plan&&plan.items.length>0
      ?<div className="chat-status chat-status-bottom">
        <PlanPanel plan={plan} collapsed={panels} onToggle={togglePanel}/>
        {mode==="planner"&&!running&&<div className="plan-approve">
          <div><strong>План готов к подтверждению</strong><span>Запустит план в режиме разработчика.</span></div>
          <button className="send-button" onClick={approvePlan}><Play size={13}/> Утвердить и начать разработку</button>
        </div>}
      </div>
      :null}

    {/* Очередь — у поля ввода, а не в конце переписки: чат открывается с начала диалога, поэтому
        сообщение, вставшее в очередь, оказывалось за пределами видимой области и появлялось на
        экране только вместе с отправкой (то есть «через время»). Здесь оно видно сразу. */}
    {queue.length>0&&<div className="message-queue message-queue-dock">
      <div className="message-queue-head"><ListPlus size={13}/> В очереди: {queue.length}</div>
      <ul>{queue.map(item=><li key={item.id}>
        <div className="message-queue-text">
          <span>{shownUserMessage(item.text).text}</span>
          {item.attachments.length>0&&<small>{item.attachments.map(attachment=>attachment.name).join(", ")}</small>}
        </div>
        <button className="ghost-button message-queue-send" onClick={()=>sendQueuedNow(item.id)} title={running?"Прервать текущую задачу и отправить это сообщение":"Отправить это сообщение"}>Отправить сейчас</button>
        <button className="icon-button" onClick={()=>removeQueued(item.id)} title="Убрать из очереди" aria-label="Убрать из очереди"><X size={13}/></button>
      </li>)}</ul>
    </div>}

    <div className="composer-wrap">
      {resume&&!running&&<div className="resume-bar" role="status">
        <span className="resume-text"><RotateCcw size={13}/> {resume.label}</span>
        <button className="send-button resume-button" onClick={continueRun} title="Продолжить прерванный запуск с того же шага" aria-label="Продолжить запуск"><Play size={13}/> Продолжить</button>
      </div>}
      {reconnect&&<div className="composer-notice reconnecting">Связь потеряна — переподключаюсь… попытка {reconnect.attempt}/{reconnect.max}</div>}
      <div className={"composer"+(dragActive?" dropping":"")}
        onDragOver={event=>{if(!event.dataTransfer?.types.includes("Files"))return;event.preventDefault();if(loaded&&!uploading)setDragActive(true)}}
        onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragActive(false)}}
        onDrop={dropFiles}>
        <textarea ref={promptBoxRef} disabled={!loaded} value={prompt} onChange={e=>setPrompt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder={loaded?"Опишите проект или задачу...":"Загружаем сессию…"} rows={3}/>

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
            {/* Режим, глубина размышления и поиск в интернете — один компактный контрол. */}
            <AgentModeControl
              mode={mode}
              reasoning={reasoning}
              webSearch={webSearch}
              reasoningAvailable={!reasoningSupport||(reasoningSupport.enabled&&reasoningSupport.status!=="rejected")}
              onMode={chooseMode}
              onReasoning={chooseReasoning}
              onWebSearch={chooseWebSearch}
            />
            <button type="button" className="composer-model" onClick={()=>onOpenModelSettings?.()} title={modelTitle} aria-label={freeModel?"Модель бесплатного тарифа. Открыть настройки AI-провайдера":"Модель: "+modelName+". Открыть настройки AI-провайдера"}>
              <Cpu size={12}/>
              <span className="composer-model-name">{modelName}</span>
            </button>
          </div>
          <div className="composer-buttons">
            {/* Поддержка стоит рядом с отправкой — там, где человек уже пишет, и её не нужно искать в меню. */}
            <SupportButton variant="composer" projectId={projectId}/>
            {running&&<button className="send-button stop-button" onClick={stop} title="Остановить" aria-label="Остановить"><Square size={14}/></button>}
            <button className="send-button" disabled={!loaded||!prompt.trim()} onClick={send} title={running?"В очередь":"Отправить"} aria-label={running?"В очередь":"Отправить"}>{running?<ListPlus size={15}/>:<Send size={15}/>}</button>
          </div>
        </div>
        {(dragActive||uploading||running||mode==="planner")&&<div className="composer-hint">{dragActive?"Отпустите файлы здесь — они появятся в папке uploads проекта":uploading?"Загружаем файлы…":running?"Агент работает — сообщение встанет в очередь":"Планировщик только изучает проект и готовит план — файлы не меняются"}</div>}
      </div>
      {/* Док действий — под полем ввода: это statusbar текущей работы. Развёрнутый список
          поднимается вверх, поверх переписки. */}
      {(actions.length>0||running)&&<div className="actions-dock" ref={actionsDockRef}>
        <ActionsDock actions={actions} running={running} progress={progress} open={actionsOpen} onOpenChange={setActionsOpen}/>
      </div>}
      {changesNotice&&<button type="button" className="changes-toast" onClick={()=>onOpenChanges?.()} disabled={!onOpenChanges} title={onOpenChanges?"Открыть историю изменений проекта":undefined}>
        <History size={14}/>
        <span className="changes-toast-text">
          <strong>Изменения сохранены · {changesNotice.shortSha}</strong>
          <small>не отправлено — откройте «Изменения»</small>
        </span>
        {onOpenChanges&&<span className="changes-toast-open">Открыть</span>}
      </button>}
      {notice&&<div className="composer-notice">{notice}</div>}
    </div>

    {/* Вопрос агента — отдельное модальное окно: оно не спорит с перепиской и не зависит от того,
        какая панель открыта, а на телефоне занимает экран целиком и прокручивается внутри себя. */}
    {questionPrompt&&<QuestionSheet
      key={questionPrompt.requestId}
      prompt={questionPrompt}
      busy={questionBusy}
      error={questionError}
      onAnswer={answer=>void answerQuestion(answer)}
      onSkip={()=>void skipQuestion()}
    />}



    {quotaNotice&&<div className="modal-backdrop" role="presentation" onMouseDown={()=>setQuotaNotice(null)}>
      <section className="modal quota-modal" role="dialog" aria-modal="true" aria-label="Лимит тарифа достигнут" onMouseDown={event=>event.stopPropagation()}>
        <header className="modal-head">
          <div><span className="eyebrow">ЛИМИТ ТАРИФА</span><h2>{quotaNotice==="storage"?"Хранилище заполнено":quotaNotice==="tokens"?"Пул токенов исчерпан":"Дневной лимит исчерпан"}</h2></div>
          <button className="icon-button" onClick={()=>setQuotaNotice(null)} aria-label="Закрыть" title="Закрыть"><X size={16}/></button>
        </header>
        <div className="modal-body">
          <div className="quota-modal-icon"><AlertTriangle size={18}/></div>
          <p className="modal-lead">{quotaNotice==="storage"
            ?"Лимит хранилища вашего тарифа достигнут: агент больше не может писать файлы в проект. Освободите место или обновите тариф — лимиты: Старт 700 МБ, Плюс 10 ГБ, Премиум 50 ГБ."
            :quotaNotice==="tokens"
            ?"Месячный пул токенов встроенной модели израсходован: он считается по фактическому расходу и возобновится первого числа следующего месяца. Точный расход виден на странице тарифов. Подключите свой AI-провайдер в настройках проекта — такие запуски идут через ваш ключ и не тратят пул платформы."
            :"Дневная квота запусков агента исчерпана. Новые запуски станут доступны после сброса по UTC или при обновлении тарифа. Лимит относится только к встроенной модели платформы: подключите свой AI-провайдер в настройках проекта — запуски пойдут через ваш ключ и модель, без дневной квоты."}</p>
        </div>
        <footer className="modal-foot">
          <button className="ghost-button" onClick={()=>setQuotaNotice(null)}>Понятно</button>
          <button className="send-button" onClick={()=>{setQuotaNotice(null);onOpenAccountSettings?.()}}>Обновить тариф</button>
        </footer>
      </section>
    </div>}
  </section>;
}
