import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";
import { AgentRuntime } from "../agent-runtime.js";
import { getCurrentUser } from "../auth/auth.js";
import { getProject,getConversation,appendConversationMessages,getProjectProvider } from "../project-store.js";
import type { ChatMessage } from "../types.js";
import { consumeAgentRun } from "../account/usage-store.js";
import { accountPlanFor } from "../billing/store.js";
import { planAllows } from "../account/entitlements.js";
import { getPlatformModelForPlan } from "../platform/platform-models.js";
import { AccountBusyError,runQueueStats,runWithRunSlot } from "../agent/run-limiter.js";
import { positiveInt } from "../concurrency.js";
import { isShuttingDown } from "../lifecycle.js";
import { PLATFORM_BUSY_CODE, PLATFORM_BUSY_MESSAGE, PLATFORM_PAUSED_MESSAGE, PLATFORM_PAUSED_REMINDER, startWaitActivity } from "../agent/wait-activity.js";

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
const SERVER_RESTARTING_ERROR="Сервер обновляется. Повторите запуск через минуту — история и проект сохранены.";
// `resume` — продолжение прерванного запуска: сообщения приходят как обычно, а рантайм добавляет
// модели системную заметку о том, что это продолжение и на каком шаге остановился план.
// `webSearch` и `browserCheck` — переключатели из меню «Режимы» в панели ввода. Приходят
// булевыми от клиента и разбираются терпимо: старый клиент их не присылает, и тогда поиск и
// браузерная проверка считаются выключенными.
export const runSchema=z.object({projectId:z.string().min(1).max(200),conversationId:z.string().max(200).optional(),messages:z.array(messageSchema).min(1).max(MAX_REQUEST_MESSAGES),model:z.string().max(200).optional(),mode:z.enum(["planner","developer"]).optional(),reasoning:z.enum(["auto","low","medium","high"]).optional(),webSearch:z.boolean().optional(),browserCheck:z.boolean().optional(),planning:z.boolean().optional(),resume:z.object({reason:z.string().max(300).optional()}).optional()});

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
 * Как часто сменяется состояние подготовки, пока запуск ждёт свободного места.
 *
 * Человек не должен видеть ни позицию в очереди, ни число ожидающих: ожидание — внутренняя
 * механика платформы. Вместо этого панель получает короткие нейтральные состояния подготовки
 * (`wait-activity.ts`) — она выглядит как обычная работа, и запуск не отменяют из-за паузы.
 */
export function waitActivityMs(){
  return positiveInt(process.env.AGENT_WAIT_ACTIVITY_MS,7_000);
}

/**
 * Сколько запуск может молчать, прежде чем сервер снимет его сам.
 *
 * Сокетный heartbeat говорит только о том, что вкладка ещё открыта: зависший провайдер,
 * Docker-задание или внешний процесс может молчать часами, а аренда аккаунта всё это время
 * остаётся занятой, и следующая реплика получает «Агент уже работает» при пустом экране.
 * Поэтому отдельный watchdog смотрит на события самого runtime. Вопрос пользователю — это
 * законное ожидание, а не зависание: пока он висит, watchdog молчит.
 */
export function runIdleTimeoutMs(){
  return Math.max(60_000,positiveInt(process.env.AGENT_RUN_IDLE_TIMEOUT_MS,15*60_000));
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
    let running=false,closed=false; let controller:AbortController|null=null; let idleAborted=false; let leaseAborted=false; let runUserId="";
    const safeSend=(payload:unknown)=>{if(!closed)try{socket.send(JSON.stringify(payload))}catch{closed=true}};
    // Aborting on close stops a run in flight *and* a wait for a free run slot, so a closed
    // tab never keeps a place in the queue while the server waits for it to answer.
    socket.on("close",()=>{closed=true;controller?.abort();controller=null;});
    socket.on("message",async (raw:RawData)=>{
      if(closed)return;
      if(running){safeSend({type:"error",error:"Агент уже выполняется в этом соединении"});return}
      running=true;
      idleAborted=false;
      leaseAborted=false;
      runUserId="";
      // The controller lives for the whole request, not only for the run: the queue wait below
      // has to end when the connection does.
      const runController=new AbortController();
      controller=runController;
      try{
        const user=await getCurrentUser(request);
        if(!user){socket.close(1008,"Требуется вход в аккаунт");closed=true;return}
        runUserId=user.id;
        const message=JSON.parse(raw.toString()) as {type?:string;request?:unknown};
        if(message.type!=="agent.run")throw new Error("Неизвестный тип сообщения");
        const parsed=runSchema.parse(message.request);
        // Owner-routing выбирает ноду по projectId из query до upgrade. Если query и тело
        // расходятся, сокет мог бы уйти владельцу одного проекта, а работать с файлами другого.
        const routedProject=new URL(request.url??"/","http://local").searchParams.get("projectId")?.trim();
        if(routedProject&&routedProject!==parsed.projectId)throw new Error("projectId в сокете не совпадает с запросом агента");
        const payloadSize=Buffer.byteLength(JSON.stringify(parsed),"utf8");
        if(payloadSize>2_000_000)throw new Error("Запрос агента слишком большой");
        const project=await getProject(parsed.projectId);
        if(!project||project.userId!==user.id)throw new Error("Проект не найден");
        // Тариф нужен всегда: по нему выбирается модель платформы и, главное, права preview и
        // хостинга, о которых агент узнаёт до первого шага. Свой AI-провайдер отменяет только
        // расход кредитов, но не тарифные ограничения проекта.
        // Если биллинг временно недоступен, права сужаются до «Старта»: это безопаснее, чем
        // выдать контейнерный preview и функции по ошибке чтения подписки.
        const plan=await accountPlanFor(user.id).catch(()=>"free" as const);
        // Свой AI-провайдер проекта доступен только на платных тарифах. Даже если в хранилище
        // осталась старая запись, на «Старте» запуск идёт через бесплатную модель платформы и
        // расходует дневной лимит.
        const ownProvider=planAllows(plan,"ownAiProvider")&&Boolean(await getProjectProvider(project.id));
        // Модель выбирает клиент, но право на неё проверяет сервер: id каталога — не имя
        // upstream-модели, и подставить чужую дорогую модель в обход тарифа нельзя. Основная
        // модель называется «nestdev», бесплатная — «nestdev-air».
        const requestedModel=parsed.model?.trim();
        if(!ownProvider&&requestedModel&&plan){
          const allowed=plan==="free"
            ? requestedModel==="nestdev-air"
            : requestedModel==="nestdev"||Boolean(await getPlatformModelForPlan(requestedModel,plan));
          if(!allowed)throw Object.assign(new Error("Модель недоступна на вашем тарифе"),{statusCode:403,code:"MODEL_NOT_AVAILABLE"});
        }
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
        // instead of starting a second build container and a second Chromium. The weekly quota is
        // consumed *inside* the place, so a full queue never burns one of the user's weekly runs.
        // The account is passed along because one account runs one agent at a time: a second tab
        // or a second project of the same user is refused instead of taking another place.
        // Сердцебиение охватывает и ожидание в очереди, и сам запуск: и то и другое может молчать
        // минутами, а молчащий сокет закрывает прокси на пути (см. runHeartbeatMs).
        const heartbeat=setInterval(()=>safeSend({type:"run.alive",at:Date.now()}),runHeartbeatMs());
        // Последнее событие runtime, а не последний heartbeat сокета: heartbeat идёт даже тогда,
        // когда сама работа зависла. `question.asked` — ожидание ответа человека, его не трогаем.
        let lastRuntimeEvent=Date.now();
        let waitingForAnswer=false;
        // Сколько раз запуск сообщал о паузе: первое сообщение обещает «около 2 минут», дальше —
        // честное «всё ещё жду», без обещаний и без слова «ошибка».
        let pauseNotices=0;
        // Строка подготовки, пока запуск ждёт свободное место; снимается первым же событием работы.
        let stopWaitActivity:(()=>void)|null=null;
        const stopWait=()=>{stopWaitActivity?.();stopWaitActivity=null;};
        const watchdog=setInterval(()=>{
          if(waitingForAnswer||Date.now()-lastRuntimeEvent<runIdleTimeoutMs())return;
          console.warn("[agent] запуск остановлен по простою: project="+parsed.projectId+" user="+user.id);
          idleAborted=true;
          safeSend({type:"error",error:"Запуск остановлен: агент слишком долго не подавал признаков работы. Повторите задачу — история и проект сохранены.",code:"RUN_IDLE_TIMEOUT"});
          runController.abort();
        },Math.min(30_000,Math.max(5_000,Math.floor(runIdleTimeoutMs()/4))));
        const emitRunEvent=(event:{type:string})=>{
          lastRuntimeEvent=Date.now();
          // Первый признак настоящей работы снимает состояние подготовки: оно не должно пережить
          // старт запуска и остаться на экране уже во время работы.
          stopWait();
          if(event.type==="question.asked")waitingForAnswer=true;
          else if(event.type!=="run.heartbeat")waitingForAnswer=false;
          safeSend(event);
        };
        try{
          // Выкатка: сервер уже не принимает новые запуски, но сокет ещё открыт. Честная
          // ошибка лучше оборванного соединения и потерянного места в очереди.
          if(isShuttingDown()){
            safeSend({type:"error",error:SERVER_RESTARTING_ERROR,code:"SERVER_RESTARTING"});
            return;
          }
          await runWithRunSlot(async()=>{
            // Запуск мог ждать в очереди с момента до остановки. Проверяем ещё раз внутри
            // слота: иначе он стартовал бы уже во время дренажа и не успел бы доработать.
            if(isShuttingDown()){
              safeSend({type:"error",error:SERVER_RESTARTING_ERROR,code:"SERVER_RESTARTING"});
              return;
            }
            const usage = await consumeAgentRun(user.id,{ownProvider});
            safeSend({type:"usage.updated",usage});
            await runtime.run({...parsed,userId:user.id,...(plan?{plan}:{}),...(history?{history}:{})},emitRunEvent,runController.signal);
          },{
            signal:runController.signal,
            userId:user.id,
            projectId:parsed.projectId,
            onQueued:()=>{
              // Позиция в очереди не отправляется: панель получает только нейтральные состояния
              // подготовки и никогда — число ожидающих (см. wait-activity.ts).
              if(stopWaitActivity)return;
              stopWaitActivity=startWaitActivity(event=>safeSend(event),waitActivityMs());
            },
            onPaused:()=>{
              // Перегрузка — не ошибка и не отказ: запуск ждёт место и продолжается сам. Строку
              // подготовки снимаем, чтобы она не подменяла собой объяснение паузы, и обновляем
              // отметку жизни: watchdog не должен снять запуск, который честно ждёт места.
              stopWait();
              lastRuntimeEvent=Date.now();
              pauseNotices++;
              safeSend({type:"run.paused",message:pauseNotices===1?PLATFORM_PAUSED_MESSAGE:PLATFORM_PAUSED_REMINDER});
            },
            onLeaseLost:()=>{
              // Аренду перехватил другой процесс: продолжать нельзя, иначе два агента пишут в
              // один проект. Останавливаем этот запуск и объясняем это пользователю один раз.
              leaseAborted=true;
              safeSend({type:"error",error:"Запуск остановлен: аренду перехватил другой процесс. Повторите задачу — история и проект сохранены.",code:"RUN_LEASE_LOST"});
              runController.abort();
            },
          });
        }finally{
          clearInterval(heartbeat);
          clearInterval(watchdog);
          stopWait();
        }
      }catch(error){
        // Остановку по простою или потере аренды уже объяснили выше; вторая ошибка «AbortError»
        // только перекрыла бы понятное сообщение и снова показала бы занятость аккаунта.
        if(idleAborted||leaseAborted)return;
        const message = requestErrorMessage(error);
        const statusCode = error && typeof error === "object" && "statusCode" in error ? (error as {statusCode?:unknown}).statusCode : undefined;
        const isQuota = statusCode === 429;
        const isStorage = error instanceof Error && error.name === "StorageLimitError";
        // Месячные кредиты закончились — это не дневная квота: панель должна предложить тариф
        // или свой ключ, а не ждать сброса по UTC.
        const isCreditBudget = error instanceof Error
          && (error.name === "CreditBudgetError" || error.name === "TokenBudgetError");
        // 503 — это ограничитель: свободных мест нет вовсе (очередь заполнена или ожидание истекло).
        // Человеку говорим одно и то же понятное предложение, без числа ожидающих и без слова «очередь».
        const isBusy = statusCode === 503;
        // Anything that carries its own code ("this account is already running an agent") is
        // passed straight through, so the panel can say what happened instead of "Ошибка".
        const ownCode = error && typeof error === "object" && "code" in error && typeof (error as {code?:unknown}).code === "string" ? (error as {code:string}).code : undefined;
        const quotaCode = isStorage ? "STORAGE_LIMIT_REACHED" : isCreditBudget ? "CREDIT_BUDGET_EXHAUSTED" : "DAILY_QUOTA_EXCEEDED";
        if(error instanceof AccountBusyError)console.warn("[agent] запуск отклонён: аккаунт ещё занят (user="+runUserId+", project="+(request.url??"")+")");
        safeSend({type:"error",error:isBusy?PLATFORM_BUSY_MESSAGE:message,...(isQuota?{code:quotaCode}:isBusy?{code:PLATFORM_BUSY_CODE}:ownCode?{code:ownCode}:{})});
      }
      finally{controller=null;running=false;}
    });
  });
}
