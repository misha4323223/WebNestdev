import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";
import { AgentRuntime } from "../agent-runtime.js";
import { getCurrentUser } from "../auth/auth.js";
import { getProject,getConversation,appendConversationMessages,getProjectProvider } from "../project-store.js";
import type { ChatMessage } from "../types.js";
import { consumeAgentRun } from "../account/usage-store.js";
import { runQueueStats,runWithRunSlot } from "../agent/run-limiter.js";
import { positiveInt } from "../concurrency.js";

const messageSchema=z.discriminatedUnion("role",[
  z.object({role:z.literal("user"),content:z.string().max(100000)}),
  z.object({role:z.literal("assistant"),content:z.string().max(100000),tool_calls:z.array(z.object({id:z.string(),name:z.string(),arguments:z.record(z.string(),z.unknown())})).optional()}),
  z.object({role:z.literal("tool"),content:z.string().max(100000),tool_call_id:z.string()})
]);
/**
 * Верхняя граница того, что сервер примет в одном запросе. Панель отправляет только реплики
 * пользователя — ответы агента и результаты инструментов живут в сохранённой сессии и в запросе не
 * нужны, — но запрос приходит не только от неё, поэтому предел остаётся: разговор законно
 * перерастает сотню реплик, и прежний предел в 100 сообщений превращал обычный диалог в ошибку
 * проверки ещё до запуска. Что реально видит модель, ограничивает бюджет контекста
 * (context-budget.ts), а размер самого запроса проверяется ниже по байтам.
 */
export const MAX_REQUEST_MESSAGES=1000;
// `resume` — продолжение прерванного запуска: сообщения приходят как обычно, а рантайм добавляет
// модели системную заметку о том, что это продолжение и на каком шаге остановился план.
export const runSchema=z.object({projectId:z.string().min(1).max(200),conversationId:z.string().max(200).optional(),messages:z.array(messageSchema).min(1).max(MAX_REQUEST_MESSAGES),model:z.string().max(200).optional(),mode:z.enum(["planner","developer"]).optional(),resume:z.object({reason:z.string().max(300).optional()}).optional()});

/**
 * Как часто работающий запуск говорит в сокет «жив».
 *
 * Запуск молчит, пока модель думает, а теперь ещё и пока ждёт лимит провайдера — до минуты в одной
 * паузе и до пяти минут за шаг (provider-retry.ts). Пустое соединение закрывает любой прокси или
 * балансировщик на пути, а закрытый сокет означает для сервера обрыв и отмену работы — то самое
 * «обрывание», из-за которого длинную задачу нельзя было довести до конца. Поэтому раз в несколько
 * секунд уходит короткое `run.alive`: панель его не показывает, он нужен только соединению.
 */
export function runHeartbeatMs(){
  return positiveInt(process.env.AGENT_RUN_HEARTBEAT_MS,20_000);
}

/**
 * Текст ошибки для панели. У ZodError `message` — это JSON-массив замечаний, и пользователь видел
 * служебную строку вида `[{"code":"too_big","maximum":100,…}]` вместо причины. То, что человеку
 * есть чем исправить, переводится; остальное сохраняет исходную формулировку.
 */
export function requestErrorMessage(error:unknown):string{
  if(error instanceof z.ZodError){
    const issue=error.issues[0];
    if(String(issue?.path[0]??"")==="messages"&&issue?.code==="too_big")
      return "История этого диалога слишком длинная для одного запуска: сервер принимает не более "+MAX_REQUEST_MESSAGES+" сообщений. Начните новый диалог или продолжите работу в новом чате.";
    return "Запрос агента не прошёл проверку: "+error.issues.map(item=>(item.path.join(".")||"запрос")+" — "+item.message).join("; ");
  }
  return error instanceof Error?error.message:String(error);
}

// Mirrors the HTTP CORS rule in index.ts: in development the browser origin varies
// (localhost, LAN IP, hosted preview domain), so any origin is accepted unless
// WEBNESTDEV_ALLOWED_ORIGINS pins a list. Production always uses the list.
function allowedOrigin(origin:string|undefined){
  if(!origin)return true;
  const production=process.env.NODE_ENV==="production";
  const configured=process.env.WEBNESTDEV_ALLOWED_ORIGINS;
  if(!production&&!configured)return true;
  const allowed=(configured??"").split(",").map(value=>value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

/**
 * The client sends its whole history, so only the messages the conversation does not
 * hold yet are appended. Occurrences are counted instead of remembered by text: sending
 * the same words twice stores two messages, while the old set-based check dropped the
 * repeat silently and the user saw their own message disappear after a reload.
 */
export function newUserMessages(stored:ChatMessage[],incoming:{role:string;content:string}[]):ChatMessage[]{
  const storedCounts=new Map<string,number>();
  for(const message of stored)if(message.role==="user")storedCounts.set(message.content,(storedCounts.get(message.content)??0)+1);
  const seenCounts=new Map<string,number>();
  const result:ChatMessage[]=[];
  for(const message of incoming){
    if(message.role!=="user")continue;
    const count=(seenCounts.get(message.content)??0)+1;
    seenCounts.set(message.content,count);
    if(count>(storedCounts.get(message.content)??0))result.push({role:"user",content:message.content});
  }
  return result;
}

export async function registerAgentWebSocket(app:FastifyInstance,runtime=new AgentRuntime()){
  app.get("/ws",{websocket:true},(socket,request)=>{
    if(!allowedOrigin(request.headers.origin)){
      socket.close(1008,"Источник запроса не разрешён");
      return;
    }
    let running=false,closed=false; let controller:AbortController|null=null;
    const safeSend=(payload:unknown)=>{if(!closed)try{socket.send(JSON.stringify(payload))}catch{closed=true}};
    // Aborting on close stops a run in flight *and* a wait for a free run slot, so a closed
    // tab never keeps a place in the queue while the server waits for it to answer.
    socket.on("close",()=>{closed=true;controller?.abort();controller=null;});
    socket.on("message",async (raw:RawData)=>{
      if(closed)return;
      if(running){safeSend({type:"error",error:"Агент уже выполняется в этом соединении"});return}
      running=true;
      // The controller lives for the whole request, not only for the run: the queue wait below
      // has to end when the connection does.
      const runController=new AbortController();
      controller=runController;
      try{
        const user=await getCurrentUser(request);
        if(!user){socket.close(1008,"Требуется вход в аккаунт");closed=true;return}
        const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
        if(message.type!=="agent.run")throw new Error("Неизвестный тип сообщения");
        const parsed=runSchema.parse(message.request);
        const payloadSize=Buffer.byteLength(JSON.stringify(parsed),"utf8");
        if(payloadSize>2_000_000)throw new Error("Запрос агента слишком большой");
        const project=await getProject(parsed.projectId);
        if(!project||project.userId!==user.id)throw new Error("Проект не найден");
        // Свой AI-провайдер проекта: запуски идут за счёт пользователя, поэтому дневной лимит
        // встроенной модели к ним не применяется (см. consumeAgentRun).
        const ownProvider=Boolean(await getProjectProvider(project.id));
        // Одно чтение сессии отвечает на два вопроса: какие из присланных сообщений новые, и какая
        // история на самом деле была у разговора. Второе важнее: модель получает её, а не копию из
        // браузера, поэтому в контекст попадают результаты инструментов прошлых запусков — и запуск
        // не зависит от того, сколько переписки панель смогла отправить.
        let history:ChatMessage[]|undefined;
        if(parsed.conversationId){
          const conversation=await getConversation(parsed.conversationId);
          if(!conversation||conversation.projectId!==parsed.projectId)throw new Error("Сессия не найдена в этом проекте");
          const newMessages=newUserMessages(conversation.messages,parsed.messages);
          if(newMessages.length)await appendConversationMessages(parsed.conversationId,newMessages);
          // Ровно то, что лежит в сессии сейчас: сохранённые ходы плюс только что добавленные.
          const stored=[...conversation.messages,...newMessages];
          if(stored.length)history=stored;
        }
        // Only so many runs this host can hold at once, so a busy server makes the new run wait
        // instead of starting a second build container and a second Chromium. The daily quota is
        // consumed *inside* the place, so a full queue never burns one of the user's daily runs.
        // The account is passed along because one account runs one agent at a time: a second tab
        // or a second project of the same user is refused instead of taking another place.
        // Сердцебиение охватывает и ожидание в очереди, и сам запуск: и то и другое может молчать
        // минутами, а молчащий сокет закрывает прокси на пути (см. runHeartbeatMs).
        const heartbeat=setInterval(()=>safeSend({type:"run.alive",at:Date.now()}),runHeartbeatMs());
        try{
          await runWithRunSlot(async()=>{
            const usage = await consumeAgentRun(user.id,{ownProvider});
            safeSend({type:"usage.updated",usage});
            await runtime.run({...parsed,userId:user.id,...(history?{history}:{})},event=>safeSend(event),runController.signal);
          },{
            signal:runController.signal,
            userId:user.id,
            onQueued:waiting=>safeSend({type:"run.queued",queued:waiting,limit:runQueueStats().limit}),
          });
        }finally{
          clearInterval(heartbeat);
        }
      }catch(error){
        const message = requestErrorMessage(error);
        const statusCode = error && typeof error === "object" && "statusCode" in error ? (error as {statusCode?:unknown}).statusCode : undefined;
        const isQuota = statusCode === 429;
        const isStorage = error instanceof Error && error.name === "StorageLimitError";
        // 503 is the limiter: the queue is full at this moment, or the wait ran out.
        const isBusy = statusCode === 503;
        // Anything that carries its own code ("this account is already running an agent") is
        // passed straight through, so the panel can say what happened instead of "Ошибка".
        const ownCode = error && typeof error === "object" && "code" in error && typeof (error as {code?:unknown}).code === "string" ? (error as {code:string}).code : undefined;
        const quotaCode = isStorage ? "STORAGE_LIMIT_REACHED" : "DAILY_QUOTA_EXCEEDED";
        safeSend({type:"error",error:message,...(isQuota?{code:quotaCode}:isBusy?{code:"SERVER_BUSY"}:ownCode?{code:ownCode}:{})});
      }
      finally{controller=null;running=false;}
    });
  });
}
