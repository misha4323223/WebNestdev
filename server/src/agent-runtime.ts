import { randomUUID } from "node:crypto";
import type { AgentRunRequest,ChatMessage,PlanState } from "./types.js";
import { createProvider } from "./provider.js";
import { appendConversationMessages,getConversationPlan,getProject,getProjectProvider,saveConversationPlan } from "./project-store.js";
import { browserCheckNotice,buildInitialMessages,closeInterruptedTurns,insertSystemNotice,resumeNotice,storedHistory,webSearchNotice } from "./agent/message-builder.js";
import { notesNotice,notesUpdateNotice,readNoteLines } from "./agent/notes.js";
import { buildProjectContext } from "./agent/context-builder.js";
import { retrieveRelevantFiles } from "./agent/context-retrieval.js";
import { executeTool } from "./agent/tool-executor.js";
import { inlineAttachedImages, visionNotice } from "./agent/attachments.js";
import { runBudgetedStep,type StepBudget } from "./agent/step-runner.js";
import { createWorkingMemory,recordWorkingChange,setWorkingCheck,setWorkingPlan,withWorkingState } from "./agent/working-memory.js";
import type { EventSink } from "./agent/types.js";
import { createReasoningBlock } from "./agent/reasoning-blocks.js";
import { selectToolNames } from "./agent/tool-catalog.js";
import { createScoutRunner,SCOUT_BUDGET_TOKENS,SCOUT_MAX_MESSAGES } from "./agent/scout.js";
import { resolveReasoning } from "./agent/reasoning-policy.js";
import { agentStepLimit,contextBudgetTokensFor,contextMaxMessagesFor,boundToolOutput,DEFAULT_CHARS_PER_TOKEN } from "./agent/context-budget.js";
import { planQaScenario } from "./qa/scenario-planner.js";
import { analyzeChangedFiles } from "./qa/diff-analyzer.js";
import { parseChangedSource, type ParsedChange } from "./qa/change-parser.js";
import { finalizeRunChanges } from "./changes/changes-service.js";
import { commitSubject } from "./changes/commit-subject.js";

/**
 * Tools that change the project and therefore trigger the automatic verification cycle.
 * `database.env` writes the project's connection string, so it belongs here too.
 */
const MUTATING_TOOLS=new Set(["fs.write","fs.edit","fs.rename","fs.delete","terminal.exec","npm.install","pip.install","net.download","database.env"]);

/** A short fact about a mutation for the run's working memory — never the file body. */
function mutationSummary(name:string,args:Record<string,unknown>,output:unknown){
  const value=output&&typeof output==="object"?output as Record<string,unknown>:{};
  if(name==="fs.write"){
    return typeof value.bytes==="number"?"записан, "+value.bytes+" Б":"записан";
  }
  if(name==="fs.edit"){
    return typeof value.replacements==="number"?"правка, замен: "+value.replacements:"точечная правка";
  }
  if(name==="fs.rename"){
    const from=typeof args.from==="string"?args.from:"?";
    return from+" → "+(typeof args.to==="string"?args.to:"?");
  }
  if(name==="fs.delete")return "удалён";
  if(name==="net.download")return typeof value.bytes==="number"?"скачан, "+value.bytes+" Б":"скачан";
  return "изменён";
}
/**
 * Git bookkeeping changes the repository, not the code, so it is not verified.
 *
 * `secrets.request` сохраняет секрет проекта, а планировщик не меняет проект вообще: там ключ
 * спрашивают в режиме разработчика. В наборы, запускающие проверку, инструмент не входит по другой
 * причине: сохранённый ключ сам по себе не требует сборки и прогона приложения — проверкой займётся
 * тот шаг, который начнёт использовать его в коде.
 *
 * `image.generate` тоже не запускает проверку: картинка — готовый ассет, собирать из-за неё проект
 * незачем. Но планировщику она запрещена: это запись в проект и расход ключа платформы.
 */
const PLANNER_FORBIDDEN_TOOLS=new Set(["git.add","git.commit","git.pull","secrets.request","access.request","deploy.plan","preview.start","preview.stop","image.generate","project.check","service.env"]);

/**
 * Planner mode still has to read the project, so plain inspection commands are allowed
 * while everything that writes is refused. Anything chained or piped is refused too:
 * one command, one answer, with no room for a write hidden behind a pipe.
 */
const READ_ONLY_COMMANDS=new Set(["ls","cat","head","tail","wc","find","grep","rg","tree","pwd","file","stat","du","df","which","whereis","echo","jq","diff","sort","cut","basename","dirname","realpath","eslint","prettier"]);
const WRITE_MARKERS=[">","<","tee ","sed -i","perl -i","--in-place","--write","--fix","--output","rm ","rmdir ","mv ","cp ","mkdir ","touch ","truncate ","chmod ","chown ","ln ","dd ","patch ","git add","git commit","git push","git pull","git fetch","git clone","git checkout","git switch","git restore","git reset","git clean","git merge","git rebase","git rm","git mv","npm i ","npm install","npm ci","npm run","npm exec","yarn add","pnpm add","bun add","bun run","pip install","python -c","node -e","node --eval","curl ","wget ","ssh ","scp ","sudo ","kill ","systemctl ","docker "];

function platformModelUnavailable(message:string){
  const error=new Error(message);
  Object.assign(error,{statusCode:403,code:"MODEL_NOT_AVAILABLE"});
  return error;
}

function isReadOnlyFind(args:string[]){
  const unsafe=["-delete","-exec","-execdir","-ok","-okdir","-fprint","-fprint0","-fprintf","-fls"];
  return !args.some(arg=>unsafe.some(flag=>arg===flag||arg.startsWith(flag+"=")));
}

function isReadOnlyGit(args:string[]){
  let index=0;
  while(args[index]&&/^--(no-pager|literal-pathspecs|no-replace-objects)$/.test(args[index]))index++;
  const sub=args[index];
  const rest=args.slice(index+1);
  if(!sub)return false;
  const readSubs=new Set(["status","diff","log","show","blame","grep","shortlog","describe","rev-parse","ls-files","ls-tree","cat-file","merge-base","name-rev","show-ref","for-each-ref","count-objects","diff-tree","whatchanged"]);
  if(readSubs.has(sub)){
    return !rest.some(arg=>/^(--output|--ext-diff|--textconv|--open-files-in-pager|--paginate)(=|$)/.test(arg));
  }
  if(sub==="branch"){
    return rest.every(arg=>/^(--list|--show-current|-a|-r|-v|--verbose)$/.test(arg));
  }
  if(sub==="tag"){
    return rest.length===0||((rest[0]==="-l"||rest[0]==="--list")&&rest.slice(1).every(arg=>!arg.startsWith("-")));
  }
  if(sub==="remote"){
    return rest.length===0||rest[0]==="-v"||rest[0]==="show"||rest[0]==="get-url";
  }
  if(sub==="stash"){
    return rest[0]==="list"||rest[0]==="show";
  }
  if(sub==="config"){
    return rest[0]==="--get"||rest[0]==="--get-all"||rest[0]==="--list"||rest[0]==="-l";
  }
  if(sub==="worktree")return rest[0]==="list";
  return false;
}

function isReadOnlyCommand(command:string){
  const value=command.trim();
  if(!value)return false;
  // Перевод строки, подстановка команды и перенаправление ввода — это несколько команд или
  // чтение за пределами проекта, даже если первое слово выглядит безобидно.
  if(/[;&|\n\r<>`]/.test(value)||value.includes("$("))return false;
  if(WRITE_MARKERS.some(marker=>value.includes(marker)))return false;
  const tokens=value.split(/\s+/);
  const head=tokens[0].replace(/^.*\//,"");
  const args=tokens.slice(1);
  if(head==="git")return isReadOnlyGit(args);
  if(head==="npm")return args.length>0&&["ls","list","ll","la"].includes(args[0]);
  if(head==="find")return isReadOnlyFind(args);
  if(head==="grep"||head==="rg")return !args.some(arg=>/^--pre(=|$)/.test(arg));
  if(head==="sort")return !args.some(arg=>/^(-o|--output|--compress-program)/.test(arg));
  if(head==="diff")return !args.some(arg=>/^(-o|--output)/.test(arg));
  if(head==="tree")return !args.some(arg=>/^(-o|--output)/.test(arg));
  return READ_ONLY_COMMANDS.has(head);
}

/**
 * Planner mode is read-only, so any call that changes something is refused. Two tool
 * families depend on the input: yandex.request reads with GET/HEAD and changes the
 * account with every other method, and terminal.exec only inspects when the command is
 * on the read-only list.
 */
export function changesSomething(name:string,input:unknown){
  if(name==="terminal.exec"){
    const command=(input as {command?:unknown}|null)?.command;
    return typeof command!=="string"||!isReadOnlyCommand(command);
  }
  if(MUTATING_TOOLS.has(name)||PLANNER_FORBIDDEN_TOOLS.has(name))return true;
  // Внешний запрос — чтение только для GET/HEAD: POST к чужому API меняет состояние вне проекта,
  // а планировщик обещал ничего не менять.
  if(name!=="yandex.request"&&name!=="net.request")return false;
  const method=(input as {method?:unknown}|null)?.method;
  if(typeof method!=="string")return false;
  return method.toUpperCase()!=="GET"&&method.toUpperCase()!=="HEAD";
}

import { commandSucceeded,countVerificationFailure,MAX_VERIFICATION_ATTEMPTS,routeFromMutation,shouldRunBrowserRuntime,verificationBuildCommand,verificationFailureSummary } from "./agent/verification-policy.js";
import { getPlatformProviderConfig } from "./provider/platform-provider.js";
import { resolvePaidPlatformModel, type PaidPlatformModelChoice } from "./platform/platform-models.js";
import { createFreeModelRoute } from "./provider/free-model.js";
import { cacheHitRate } from "./provider/prompt-caching.js";
import { getSandbox } from "./sandbox-manager.js";
import { readBuildScript } from "./preview/static-plan.js";
import { recordRunUsage } from "./account/usage-store.js";
import { creditsForUsage, mainCreditRates, type CreditRates } from "./account/credits.js";
import { beginRun,endRun } from "./agent/active-runs.js";


/**
 * Сборка проекта — только если он её объявил. Статическая страница без `package.json` не имеет
 * скрипта сборки, и `npm run build` в ней падает с `ENOENT …/package.json`: это не дефект проекта,
 * а проверка, которая спрашивает не о том. Раньше такие падения считались отказом проверки и
 * останавливали запуск на третьем файле статического сайта.
 */
async function projectBuildCommand(projectId:string,userId:string){
  try{
    const config=await getSandbox(projectId,userId);
    return verificationBuildCommand(await readBuildScript(config.root));
  }catch{
    // Тип проекта неизвестен — ведём себя как раньше, а не пропускаем сборку молча.
    return "npm run build";
  }
}

export class AgentRuntime {
  async run(request:AgentRunRequest,emit:EventSink,signal?:AbortSignal){
    const runId=randomUUID(); emit({type:"run.started",runId});
    // The idle sweeper must not stop this project's preview while the run is still working.
    beginRun(request.projectId,request.conversationId);
    const usageTotals={promptTokens:0,completionTokens:0,cachedPromptTokens:0,cacheWritePromptTokens:0,estimated:false};
    let usageModel="";
    let usageModelId="nestdev";
    // Ставки фиксируются на старте запуска: правка каталога во время работы не меняет цену задним числом.
    let usageCreditRates:CreditRates|null=null;
    // Токены в `model_usage` — это расход платформы: из них считается месячный пул тарифа и
    // стоимость для владельца. Запуск на ключе пользователя платформа не оплачивает, поэтому
    // в этот журнал не попадает — иначе пул списывался бы за чужие токены.
    let platformModel=false;
    try{
      const project=await getProject(request.projectId);
      if(!project||project.userId!==request.userId)throw new Error("Проект не найден");
      const config=await getProjectProvider(request.projectId);
      // Свой провайдер проекта — значит токены платит пользователь, а не платформа.
      platformModel=!config;
      const defaultPlatformConfig=getPlatformProviderConfig();
      const requestedModel=request.model?.trim();
      // Бесплатный тариф без своего ключа идёт через бесплатную модель с резервом на платформенную.
      // Платные тарифы и проекты со своим провайдером сюда не попадают — у них всё как раньше.
      const freeRoute=!config&&request.plan==="free"?createFreeModelRoute():null;
      // Дополнительные модели (Max, Mini) лежат в каталоге платформы. Клиент присылает их id,
      // а не имя upstream-модели: иначе любой запуск мог бы попросить чужую дорогую модель в обход
      // тарифа. Основная модель остаётся «nestdev», бесплатная — «nestdev-air».
      let platformChoice:PaidPlatformModelChoice|null=null;
      if(!config&&request.plan){
        if(request.plan==="free"){
          if(requestedModel&&requestedModel!=="nestdev-air")throw platformModelUnavailable("Эта модель доступна только на платном тарифе");
        }else if(requestedModel&&requestedModel!=="nestdev"){
          platformChoice=await resolvePaidPlatformModel(requestedModel,request.plan,defaultPlatformConfig);
          if(!platformChoice)throw platformModelUnavailable("Модель недоступна на вашем тарифе или ещё не настроена");
        }
      }else if(!config&&requestedModel&&requestedModel!=="nestdev"){
        // Запуск без тарифа — служебный/тестовый: каталог ему не разрешён, только основная модель.
        throw platformModelUnavailable("Модель недоступна: тариф не определён");
      }
      const platformConfig=platformChoice?.config??defaultPlatformConfig;
      usageModelId=freeRoute?"nestdev-air":platformChoice?.id??"nestdev";
      usageCreditRates=freeRoute||request.plan==="free"?null:platformChoice?.creditRates??mainCreditRates();
      const provider=freeRoute?.provider??createProvider(config??platformConfig??undefined);
      const projectContext=await buildProjectContext(project,request.userId);
      // История — это сохранённый разговор, а не копия из браузера: в ней лежат результаты
      // инструментов, она не растёт от длины переписки в панели и не расходится с тем, что
      // пользователь видит в чате. Присланные сообщения остаются запасным путём для запуска,
      // который начался раньше первой записи в сессию.
      const stored=request.history?.length?storedHistory(request.history):[];
      const history:ChatMessage[]=stored.length?stored:request.messages;
      const task=history.filter(message=>message.role==="user").at(-1)?.content??"";
      // The stored plan is a bookmark, not only for a resumed run: a user can send a new message
      // after a normal pause, and the unfinished plan is still the work in progress. A plan whose
      // every item is done is history, not a current instruction.
      let savedPlan:PlanState|undefined;
      if(request.conversationId){
        try{savedPlan=await getConversationPlan(request.conversationId);}catch(error){console.error("Failed to read the stored plan",error);}
      }
      const activeSavedPlan=savedPlan&&Array.isArray(savedPlan.items)&&savedPlan.items.some(item=>item.status!=="done")?savedPlan:undefined;
      const working=createWorkingMemory(task,activeSavedPlan);
      working.planFromPreviousRun=Boolean(activeSavedPlan);
      const mode=request.mode==="planner"?"planner":"developer";
      // Старые клиенты могли не присылать глубину: для них работает автоматический выбор.
      const requestedReasoning=request.reasoning??"auto";
      // Первый запуск нового проекта: окно планирования просит только вопросы и резюме,
      // поэтому модель не осматривает пустой проект и не рассказывает, что в нём ничего нет.
      const planning=mode==="planner"&&request.planning===true;
      // Подбор файлов по задаче — работа для проекта с кодом; в планировании нового проекта
      // он только добавляет пустой контекст и задерживает первый вопрос.
      const relevantFiles=planning?"":await retrieveRelevantFiles(request.projectId,request.userId,task);
      // Браузерная проверка — разрешение на этот запуск, а не свойство тарифа. Выключенная
      // проверка отключает и автоматическую Chromium-QA после правок.
      const browserCheckEnabled=request.browserCheck===true;
      // Каталог фиксируется один раз на запуск: схемы не должны меняться между шагами,
      // иначе кэш префикса DeepSeek будет промахиваться на каждом запросе.
      const toolNames=selectToolNames({
        mode,
        task,
        webSearch:request.webSearch===true,
        browserCheck:browserCheckEnabled,
      });
      // Остановленный в прошлый раз запуск не оставляет ответа на просьбу пользователя, и она
      // выглядит для модели действующей задачей. Заметка закрывает такой ход, и новое сообщение
      // («ты тут?») не превращается в продолжение старой команды. При `resume` её быть не должно:
      // там пользователь как раз просит продолжить.
      const cleanHistory=request.resume?history:closeInterruptedTurns(history);
      let messages:ChatMessage[]=buildInitialMessages(cleanHistory,projectContext+"\n\nTASK-RELEVANT SOURCE FILES\n"+relevantFiles,mode,planning);
      // Переключатель поиска в интернете живёт в панели ввода, поэтому модель узнаёт о нём из
      // заметки, а инструменты проверяют тот же флаг сами (web-tools.ts). Выключенный поиск —
      // не повод выдумывать факты, а повод попросить пользователя включить кнопку.
      messages=insertSystemNotice(messages,webSearchNotice(request.webSearch===true));
      // Тот же принцип для Chromium: без разрешения модель не должна тратить шаг на отказ.
      messages=insertSystemNotice(messages,browserCheckNotice(browserCheckEnabled));
      // Заметка о согласованном — отдельным системным сообщением. Обрезка контекста системные
      // сообщения не выбрасывает и не сокращает, поэтому «какой вариант мы выбрали» остаётся
      // в промпте даже тогда, когда вся история вокруг уже свёрнута в срез.
      let noteLines:string[]=[];
      try{ noteLines=await readNoteLines(request.projectId,request.userId,request.conversationId); }
      catch(error){ console.error("Failed to read the project notes",error); }
      messages=insertSystemNotice(messages,notesNotice(noteLines));
      if(request.resume){
        // Возобновление: история — это память о сделанном, сохранённый план — закладка. Без заметки
        // модель с большой историей часто начинает задачу заново или переспрашивает пользователя.
        messages=insertSystemNotice(messages,resumeNotice(request.resume.reason,activeSavedPlan));
      }
      const model=freeRoute?.model
        ??(config?(requestedModel||config.model):platformChoice?.config.model??platformConfig?.model);
      if(!model)throw new Error("Модель AI не настроена");
      // Имя модели бесплатного тарифа не уходит в журнал расхода: в интерфейсе его тоже нет.
      usageModel=freeRoute?"free-model":model;
      const maxSteps=agentStepLimit();
      const contextTier=freeRoute?"free":"paid";
      // Контекст ограничен на каждом шаге, а не только в начале запуска: сообщения добавляются
      // по ходу (выводы инструментов, проверки), а модель получает их целиком. Как именно шаг
      // подрезается и что происходит при отказе провайдера — в agent/step-runner.ts.
      // У Max и Mini может быть меньше окно, чем общий бюджет платного тарифа. Модель сама
      // объявляет свой предел, и он важнее общего: иначе провайдер ответит отказом по контексту.
      let budget:StepBudget={budgetTokens:platformChoice?.contextTokens??contextBudgetTokensFor(contextTier),charsPerToken:DEFAULT_CHARS_PER_TOKEN,maxMessages:contextMaxMessagesFor(contextTier)};
      // У разведчика свой контекст и свой потолок: он не видит историю основного запуска и не
      // расходует его бюджет. Расход при этом общий — токены потрачены одной задачей.
      const scout=createScoutRunner({
        provider,model,runId,request,emit,
        ...(signal?{signal}:{}),
        budget:{
          budgetTokens:Math.min(SCOUT_BUDGET_TOKENS,budget.budgetTokens),
          charsPerToken:DEFAULT_CHARS_PER_TOKEN,
          maxMessages:Math.min(SCOUT_MAX_MESSAGES,budget.maxMessages),
        },
        onUsage:usage=>{
          usageTotals.promptTokens+=usage.promptTokens;
          usageTotals.completionTokens+=usage.completionTokens;
          usageTotals.cachedPromptTokens+=usage.cachedPromptTokens;
          usageTotals.cacheWritePromptTokens+=usage.cacheWritePromptTokens;
          usageTotals.estimated=usageTotals.estimated||usage.estimated;
        },
      });
      // Вложения пользователя — в контекст главной модели: картинка уходит частью того же
      // сообщения, а не вторым запросом к отдельной модели. Истории это не меняет: base64 живёт
      // только в этом запуске (agent/attachments.ts), сессия по-прежнему хранит текст со ссылкой.
      // Если главная модель картинки не принимает — описание сделает модель зрения из админки,
      // а без неё модель получит честную заметку «изображение недоступно».
      try{
        const inlined=await inlineAttachedImages(messages,{
          projectId:request.projectId,
          userId:request.userId,
          model,
          ...(signal?{signal}:{}),
        });
        messages=inlined.messages;
        const notice=visionNotice(inlined);
        if(notice)messages=insertSystemNotice(messages,notice);
        // Строка в журнал: по ней видно, дошла ли картинка до главной модели или ушла на описание.
        if(inlined.attached||inlined.described)console.log("[vision] изображения: "+inlined.attached+" в контексте, описание модели зрения: "+(inlined.described?"да":"нет")+", модель "+model);
      }catch(error){
        // Вложение — не повод не начинать работу: без картинки запуск продолжается как раньше.
        console.error("Failed to inline the attached images",error);
      }
      let consecutiveVerifyFailures=0;
      let consecutiveScenarioFailures=0;
      let scenarioLimitNoticeShown=false;
      const resetScenarioAttempts=(argumentsValue:Record<string,unknown>)=>{
        if(argumentsValue.resetAttempts!==true&&argumentsValue.retry!==true)return false;
        consecutiveScenarioFailures=0;
        scenarioLimitNoticeShown=false;
        return true;
      };
      const noteScenarioLimit=()=>{
        if(scenarioLimitNoticeShown)return;
        scenarioLimitNoticeShown=true;
        messages.push({role:"system",content:"BROWSER QA ATTEMPT LIMIT REACHED. The limit is not a run-ending failure: inspect the full failedStep.detail/callLog, overlap diagnostics and failure screenshot, fix the cause, then call browser.scenario with resetAttempts:true to continue in this same run. Do not repeat the same failing scenario without a change."});
      };
      let lastVerificationFailure="";
      let verificationPending=false;
      let scenarioPending=false;
      // The plan is what the user watches during a long run, so it is tracked per run.
      let planSeen=Boolean(activeSavedPlan?.items.length);
      let planNudged=false;
      const changedFiles=new Set<string>();
      const parsedChanges:ParsedChange[]=[];
      // A model can get stuck repeating one failing call. The message is not a hard stop: it names
      // the repetition and asks for a different action, so a temporary error is still recoverable.
      const repeatedToolFailures=new Map<string,number>();
      let repeatedToolNotice="";
      const noteToolFailure=(call:{name:string;arguments:Record<string,unknown>},failed:boolean)=>{
        const key=call.name+"\u0000"+JSON.stringify(call.arguments??{}).slice(0,1200);
        if(!failed){repeatedToolFailures.delete(key);return;}
        const count=(repeatedToolFailures.get(key)??0)+1;
        repeatedToolFailures.set(key,count);
        while(repeatedToolFailures.size>64){
          const oldest=repeatedToolFailures.keys().next().value;
          if(oldest===undefined)break;
          repeatedToolFailures.delete(oldest);
        }
        if(count===3){
          // Delivered at the start of the next model step, not between the tool results of this
          // one: a provider expects the answers to one assistant turn to stay together.
          repeatedToolNotice="REPEATED TOOL FAILURE: "+call.name+" failed with the same arguments three times. Do not repeat it. Read the actual file or error, use the working state, and choose a different action; if the task cannot proceed, explain the blocker instead of retrying.";
        }
      };

      /**
       * Everything the user can see — the answers, the thinking behind them and every
       * action with its result — belongs to the conversation, so it is written there as
       * it happens. A reload, a switched tab or a closed window loses nothing.
       */
      const persist=async (entries:ChatMessage[])=>{
        if(!request.conversationId||!entries.length)return;
        // Никакого чтения сессии ради записи: каждый шаг добавляет сообщения, и разговор целиком
        // загружался бы несколько раз за шаг только для того, чтобы его же и дописать. Что сессия
        // принадлежит этому проекту, маршрут проверил при старте запуска.
        try{ await appendConversationMessages(request.conversationId,entries); }
        catch(error){console.error("Failed to persist conversation messages",error);}
      };
      const finishTool=async (call:{id:string;name:string},output:unknown)=>{
        emit({type:"tool.finished",runId,toolCallId:call.id,name:call.name,output});
        await persist([{role:"tool",content:JSON.stringify(output??null),tool_call_id:call.id}]);
      };

      const runVerification=async (browserRuntime:boolean,routes:string[],checkTypeScript=false)=>{
        const buildCommand=await projectBuildCommand(request.projectId,request.userId);
        const verifyCalls=[
          ...(checkTypeScript?[{id:randomUUID(),name:"project.check",arguments:{typecheck:true,lint:false}}]:[]),
          ...(buildCommand?[{id:randomUUID(),name:"terminal.exec",arguments:{command:buildCommand}}]:[]),
          {id:randomUUID(),name:"preview.start",arguments:{}},
          {id:randomUUID(),name:"project.verify",arguments:{path:routes[0]??"/"}},
          ...(browserRuntime?routes.map(path=>({id:randomUUID(),name:"browser.runtime",arguments:{path}})):[]),
        ];
        const qa={build:!buildCommand,preview:false,ssr:false,browser:browserRuntime?false:true};
        // Verification is the runtime's own turn, but its tool results still need a call before
        // them: a strict OpenAI/DeepSeek request rejects a tool message without an assistant
        // tool_call. One synthetic turn covers every check; skipped checks get a paired result too.
        messages.push({
          role:"assistant",
          content:"",
          tool_calls:verifyCalls.map(call=>({id:call.id,name:call.name,arguments:call.arguments})),
        });
        const skipRemaining=(failedId:string,reason:string)=>{
          let afterFailed=false;
          for(const call of verifyCalls){
            if(afterFailed)messages.push({role:"tool",content:JSON.stringify({ok:false,skipped:true,reason}),tool_call_id:call.id});
            if(call.id===failedId)afterFailed=true;
          }
        };
        for(const verifyCall of verifyCalls){
          if(signal?.aborted)throw new Error("Запуск агента отменён");
          emit({type:"tool.started",runId,toolCallId:verifyCall.id,name:verifyCall.name,input:verifyCall.arguments});
          try{
            const output=await executeTool(verifyCall as any,{runId,request,emit,signal,toolNames});
            await finishTool(verifyCall,output);
            messages.push({role:"tool",content:boundToolOutput(verifyCall.name,output),tool_call_id:verifyCall.id});
            if(verifyCall.name==="project.check"){
              const passed=Boolean((output as {ok?:boolean}).ok);
              if(!passed){
                lastVerificationFailure=verificationFailureSummary(output)||lastVerificationFailure;
                setWorkingCheck(working,"проверка","ошибка");
                setWorkingCheck(working,"TypeScript","ошибка");
                skipRemaining(verifyCall.id,lastVerificationFailure||"TypeScript не прошёл");
                return false;
              }
              setWorkingCheck(working,"TypeScript",(output as {configured?:boolean}).configured===false?"не настроена":"пройдена");
            }
            if(verifyCall.name==="terminal.exec"){
              qa.build=commandSucceeded(output);
              if(!qa.build){
                lastVerificationFailure=verificationFailureSummary(output)||lastVerificationFailure;
                setWorkingCheck(working,"проверка","ошибка");
                setWorkingCheck(working,"сборка","ошибка");
                skipRemaining(verifyCall.id,lastVerificationFailure||"сборка не прошла");
                return false;
              }
            }
            if(verifyCall.name==="preview.start"){
              qa.preview=Boolean((output as {running?:boolean;ok?:boolean}).running??(output as {ok?:boolean}).ok);
              if(!qa.preview){
                lastVerificationFailure=verificationFailureSummary(output)||lastVerificationFailure;
                setWorkingCheck(working,"проверка","ошибка");
                setWorkingCheck(working,"превью","ошибка");
                skipRemaining(verifyCall.id,lastVerificationFailure||"превью не запустилось");
                return false;
              }
            }
            if(verifyCall.name==="project.verify"){
              qa.ssr=Boolean((output as {ok?:boolean}).ok);
              if(!qa.ssr){
                lastVerificationFailure=verificationFailureSummary(output)||lastVerificationFailure;
                setWorkingCheck(working,"проверка","ошибка");
                setWorkingCheck(working,"SSR","ошибка");
                skipRemaining(verifyCall.id,lastVerificationFailure||"SSR не прошёл");
                return false;
              }
            }
            if(verifyCall.name==="browser.runtime"){
              qa.browser=Boolean((output as {ok?:boolean}).ok);
              if(!qa.browser){
                lastVerificationFailure=verificationFailureSummary(output)||lastVerificationFailure;
                setWorkingCheck(working,"проверка","ошибка");
                setWorkingCheck(working,"браузер","ошибка");
                skipRemaining(verifyCall.id,lastVerificationFailure||"браузерная проверка не прошла");
                return false;
              }
            }
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            const output={ok:false,error:message};
            lastVerificationFailure=message;
            setWorkingCheck(working,"проверка","ошибка");
            await finishTool(verifyCall,output);
            messages.push({role:"tool",content:boundToolOutput(verifyCall.name,output),tool_call_id:verifyCall.id});
            skipRemaining(verifyCall.id,message);
            return false;
          }
        }
        setWorkingCheck(working,"проверка","пройдена");
        setWorkingCheck(working,"сборка",buildCommand?"пройдена":"не требуется");
        setWorkingCheck(working,"превью","запущено");
        setWorkingCheck(working,"SSR","пройден");
        if(browserRuntime)setWorkingCheck(working,"браузер","пройден");
        messages.push({role:"system",content:"QA VERIFICATION PASSED: TS="+(checkTypeScript?"CHECKED":"SKIPPED (no TypeScript files changed)")+", BUILD="+(buildCommand?"PASS":"SKIPPED (the project declares no build script)")+", PREVIEW=PASS, SSR=PASS"+(browserRuntime?", BROWSER=PASS":"")});
        return true;
      };

      for(let step=0;step<maxSteps;step++){
        if(signal?.aborted)throw new Error("Запуск агента отменён");
        if(repeatedToolNotice){
          messages.push({role:"system",content:repeatedToolNotice});
          repeatedToolNotice="";
        }
        // The run's clipboard goes last, after every tool result and notice of the previous step.
        // Replacing it here (rather than appending another copy) keeps the prompt prefix stable and
        // the tail small; `trimMessagesToBudget` never drops or shrinks a system message.
        messages=withWorkingState(messages,working);
        const stepReasoning=resolveReasoning({
          requested:requestedReasoning,
          step:step+1,
          task,
          mode,
          verificationFailures:consecutiveVerifyFailures,
          changedFiles:changedFiles.size,
          resumed:Boolean(request.resume),
        });
        const context={runId,request,emit,signal,step:step+1,toolNames,reasoning:stepReasoning,scout};
        const stepStartedAt=new Date().toISOString();
        const stepRun=await runBudgetedStep(provider,messages,model,context,budget,{
          // Шаг и размер контекста идут в панель: видно, что запуск работает и сколько занято.
          // То же число попадает в рабочую память — на следующем шаге модель уже знает остаток
          // и заранее выбирает grep/outline вместо чтения файлов целиком.
          onPrepared:prepared=>{
            working.context={tokens:prepared.tokens,budgetTokens:prepared.budgetTokens};
            emit({type:"run.progress",runId,step:step+1,maxSteps,tokens:prepared.tokens,budget:prepared.budgetTokens});
          },
        });
        messages=stepRun.messages;
        budget=stepRun.budget;
        const result=stepRun.result;
        // Узел истории создаётся из того же текста, что уже ушёл в поток. Это не второй запрос к
        // модели, а только запись того, что она уже сказала.
        const reasoningBlocks=result.reasoning
          ? [createReasoningBlock({
            // Тот же id и время старта, что уже ушли в поток: иначе live-блок и сохранённый
            // узел были бы двумя разными узлами с одинаковым текстом.
            ...(result.reasoningBlock?{id:result.reasoningBlock.id}:{}),
            runId,step:step+1,text:result.reasoning,calls:result.calls,
            startedAt:result.reasoningBlock?.startedAt??stepStartedAt,finishedAt:new Date().toISOString(),
          })]
          : undefined;
        usageTotals.promptTokens+=result.usage.promptTokens;
        usageTotals.completionTokens+=result.usage.completionTokens;
        usageTotals.cachedPromptTokens+=result.usage.cachedPromptTokens;
        usageTotals.cacheWritePromptTokens+=result.usage.cacheWritePromptTokens;
        usageTotals.estimated=usageTotals.estimated||result.usage.estimated;

        if(!result.calls.length){
          if(verificationPending||scenarioPending){
            // Модель объявила задачу готовой, а проверка не прошла — вот это и есть неудачная попытка.
            if(verificationPending)consecutiveVerifyFailures=countVerificationFailure(consecutiveVerifyFailures,"finish");
            if(scenarioPending)consecutiveScenarioFailures=countVerificationFailure(consecutiveScenarioFailures,"finish");
            if(verificationPending&&consecutiveVerifyFailures>=MAX_VERIFICATION_ATTEMPTS){
              throw new Error("Проверка не прошла несколько раз подряд — достигнут предел попыток проверки"+(lastVerificationFailure?": "+lastVerificationFailure:""));
            }
            if(scenarioPending&&consecutiveScenarioFailures>=MAX_VERIFICATION_ATTEMPTS)noteScenarioLimit();
            messages.push({
              role:"system",
              content:scenarioPending
              ? "The user-visible change passed build, preview, SSR and browser smoke verification, but Browser QA is still pending. You MUST call browser.scenario now. Derive the shortest meaningful end-to-end user flow from the original task and the changed route, using up to 80 steps when the flow genuinely needs them (keep it as short as possible). If the scenario fails, inspect its diagnostics, fix the smallest necessary issue, and run the scenario again. Do not finish the task until browser.scenario returns ok=true."
              : "The requested change is not verified yet. Do not finish the task. Inspect the latest verification diagnostic, make the smallest necessary fix, and run the verification again. A successful tool call is not sufficient proof of completion.",
            });
            continue;
          }

          const text=result.text||"Модель не вернула ответ.";
          if(!result.text)emit({type:"message.delta",runId,delta:text});
          await persist([{role:"assistant",content:text,...(result.reasoning?{reasoning:result.reasoning}:{}),...(reasoningBlocks?{reasoningBlocks}:{})}]);
          // Изменения записываются в историю проекта только теперь: сборка, предпросмотр и
          // браузерная проверка уже прошли, то есть в точку попадает проверенное состояние.
          // Точка остаётся локальной: отправку на GitHub пользователь запускает сам, агент
          // не делает пуш по своей инициативе. Отказ git не отменяет выполненную задачу —
          // он логируется, а задача завершается как обычно.
          if(mode==="developer"){
            try{
              // Тема коммита — сделанное, а не текст запроса: пункты плана этой задачи, а без
              // плана — первое предложение запроса. Иначе в истории проекта лежала бы вся переписка.
              const title=commitSubject({
                task,
                ...(working.plan?{plan:working.plan}:{}),
                planFromPreviousRun:working.planFromPreviousRun,
              });
              const changes=await finalizeRunChanges({
                projectId:request.projectId,userId:request.userId,runId,
                ...(request.conversationId?{conversationId:request.conversationId}:{}),
                title,
              });
              if(changes)emit({
                type:"changes.created",runId,branch:changes.branch,pushed:false,
                checkpoint:{sha:changes.checkpoint.sha,shortSha:changes.checkpoint.shortSha,subject:changes.checkpoint.subject,filesChanged:changes.checkpoint.filesChanged},
              });
            }catch(error){console.error("Failed to record the run checkpoint",error);}
          }
          emit({type:"run.completed",runId}); return;
        }

        const assistantMessage:ChatMessage={role:"assistant",content:result.text,tool_calls:result.calls,...(result.reasoning?{reasoning:result.reasoning}:{}),...(reasoningBlocks?{reasoningBlocks}:{})};
        messages.push(assistantMessage);
        // The assistant turn is part of the user-visible history, so it is persisted as it
        // is produced — with the thinking behind it — and survives a reload mid-run.
        if(result.calls.length||result.text.trim())await persist([assistantMessage]);

        let mutationSucceeded=false;
        let browserRuntimeRequired=false;
        const verificationRoutes=new Set<string>();

        for(const call of result.calls){
          if(signal?.aborted)throw new Error("Запуск агента отменён");
          emit({type:"tool.started",runId,toolCallId:call.id,name:call.name,input:call.arguments});
          // Planner mode is read-only by construction, not just by instruction.
          if(mode==="planner"&&changesSomething(call.name,call.arguments)){
            const refusal={error:"Режим «Планировщик»: изменения и запуск отключены. Разрешены только чтение файлов, команды из списка только-для-чтения (без перенаправлений, установки пакетов и git add/commit) и GET/HEAD-запросы. Опишите этот шаг в плане и продолжите изучение проекта.",mode:"planner"};
            await finishTool(call,refusal);
            messages.push({role:"tool",content:JSON.stringify(refusal),tool_call_id:call.id});
            noteToolFailure(call,true);
            continue;
          }
          try{
            if(call.name==="browser.scenario")resetScenarioAttempts(call.arguments);
            const output=await executeTool(call,context);
            if(signal?.aborted)throw new Error("Запуск агента отменён");
            await finishTool(call,output);
            // Ограниченный вывод: журнал сборки читается один раз, а в истории остаётся до конца запуска.
            messages.push({role:"tool",content:boundToolOutput(call.name,output),tool_call_id:call.id});
            const failedOutput=output!==null&&typeof output==="object"&&((output as {ok?:unknown}).ok===false||typeof (output as {error?:unknown}).error==="string");
            noteToolFailure(call,failedOutput);

            // Решение записано — заметка в промпте обновляется сразу, на этом же шаге: следующая
            // модель должна уже видеть новую договорённость, не дожидаясь следующего запуска.
            // Обновление дописывается в конец, а не заменяет прежний системный блок: замена в
            // середине промпта ломает кэш-префикс DeepSeek и заставляет заново обрабатывать всю
            // историю. Актуальный список в конце важнее старого, а начало остаётся стабильным.
            if(call.name==="note.remember"){
              const stored=(output as {notes?:unknown}).notes;
              const added=(output as {added?:unknown}).added===true;
              const note=(output as {note?:unknown}).note;
              if(Array.isArray(stored)&&stored.every(item=>typeof item==="string")){
                noteLines=stored as string[];
                // Только новая строка, а не весь список: иначе несколько заметок за запуск
                // раздували бы конец промпта и съедали бюджет контекста.
                if(added&&typeof note==="string"&&note.trim()){
                  messages.push({role:"system",content:notesUpdateNotice(note)});
                }
              }
            }

            if(call.name==="plan.update"){
              const plan=(output as {plan?:PlanState}).plan;
              if(plan){
                planSeen=true;
                setWorkingPlan(working,plan);
                emit({type:"plan.updated",runId,plan});
                if(request.conversationId){
                  try{await saveConversationPlan(request.conversationId,plan);}
                  catch(error){console.error("Failed to persist the plan",error);}
                }
              }
            }

            if(call.name==="browser.scenario"){
              if((output as {ok?:boolean}).ok===true){
                scenarioPending=false;
                consecutiveScenarioFailures=0;
                scenarioLimitNoticeShown=false;
                setWorkingCheck(working,"сценарий браузера","пройден");
                messages.push({role:"system",content:"BROWSER QA SCENARIO PASSED: user-visible flow completed successfully with no browser console, page, HTTP, or network errors."});
              }else{
                scenarioPending=true;
                setWorkingCheck(working,"сценарий браузера","ошибка");
                consecutiveScenarioFailures++;
                if(consecutiveScenarioFailures>=MAX_VERIFICATION_ATTEMPTS)noteScenarioLimit();
              }
            }

            if(call.name==="project.verify"||call.name==="browser.runtime"){
              if((output as {ok?:boolean}).ok===true){
                verificationPending=false;
                consecutiveVerifyFailures=0;
                setWorkingCheck(working,"проверка","пройдена");
                setWorkingCheck(working,call.name==="browser.runtime"?"браузер":"страница",call.name==="browser.runtime"?"пройден":"доступна");
              }else{
                verificationPending=true;
                lastVerificationFailure=verificationFailureSummary(output)||lastVerificationFailure;
                setWorkingCheck(working,"проверка","ошибка");
                setWorkingCheck(working,call.name==="browser.runtime"?"браузер":"страница","ошибка");
                consecutiveVerifyFailures=countVerificationFailure(consecutiveVerifyFailures,"tool");
              }
            }

            if(MUTATING_TOOLS.has(call.name)){
              mutationSucceeded=true;
              browserRuntimeRequired=browserRuntimeRequired||shouldRunBrowserRuntime(call.name,call.arguments);
              verificationRoutes.add(routeFromMutation(call.name,call.arguments));
              const changedPath=typeof call.arguments.path==="string"?call.arguments.path:typeof call.arguments.to==="string"?call.arguments.to:"";
              if(changedPath){
                changedFiles.add(changedPath);
                recordWorkingChange(working,changedPath,mutationSummary(call.name,call.arguments,output));
                const source=typeof call.arguments.content==="string"?call.arguments.content:"";
                if(source) parsedChanges.push(...parseChangedSource(changedPath,source).changes);
                const removedChanges=(output as {removedChanges?:ParsedChange[]}).removedChanges;
                if(call.name==="fs.delete"&&Array.isArray(removedChanges)) parsedChanges.push(...removedChanges);
              }
            }
          }catch(error){
            const message=error instanceof Error?error.message:String(error);
            await finishTool(call,{error:message});
            messages.push({role:"tool",content:JSON.stringify({error:message}),tool_call_id:call.id});
            noteToolFailure(call,true);
          }
        }

        if(mutationSucceeded){
          verificationPending=true;
          const checkTypeScript=[...changedFiles].some(file=>/\.(ts|tsx|mts|cts)$/i.test(file));
          const verified=await runVerification(browserCheckEnabled&&browserRuntimeRequired,[...verificationRoutes],checkTypeScript);
          if(verified){
            consecutiveVerifyFailures=0;
            verificationPending=false;
            if(browserCheckEnabled&&browserRuntimeRequired){
              scenarioPending=true;
              consecutiveScenarioFailures=0;
              const affectedRoute=[...verificationRoutes][0]??"/";
              const changeAnalysis=analyzeChangedFiles([...changedFiles],parsedChanges);
              const plannedScenario=planQaScenario(task,affectedRoute,changeAnalysis.kind,changeAnalysis.confidence,parsedChanges);
              (plannedScenario as Record<string,unknown>).changeAnalysis=changeAnalysis;
              const scenarioCall={id:randomUUID(),name:"browser.scenario",arguments:plannedScenario};
              emit({type:"tool.started",runId,toolCallId:scenarioCall.id,name:scenarioCall.name,input:scenarioCall.arguments});
              try{
                const scenarioOutput=await executeTool(scenarioCall as any,{runId,request,emit,signal,toolNames});
                await finishTool(scenarioCall,scenarioOutput);
                messages.push({role:"tool",content:boundToolOutput(scenarioCall.name,scenarioOutput),tool_call_id:scenarioCall.id});
                if((scenarioOutput as {ok?:boolean}).ok===true){
                  scenarioPending=false;
                  consecutiveScenarioFailures=0;
                  scenarioLimitNoticeShown=false;
                  messages.push({role:"system",content:"BROWSER QA SCENARIO PASSED: the automatically planned user flow passed in Chromium with no browser console, page, HTTP, or network errors."});
                }else{
                  scenarioPending=true;
                  setWorkingCheck(working,"сценарий браузера","ошибка");
                  consecutiveScenarioFailures++;
                  messages.push({role:"system",content:"AUTOMATIC BROWSER QA FAILED. Inspect the scenario diagnostics and failure screenshot, fix the smallest necessary issue, then repeat verification. Do not finish while Browser QA is pending."});
                  if(consecutiveScenarioFailures>=MAX_VERIFICATION_ATTEMPTS)noteScenarioLimit();
                }
              }catch(error){
                const message=error instanceof Error?error.message:String(error);
                scenarioPending=true;
                setWorkingCheck(working,"сценарий браузера","ошибка");
                consecutiveScenarioFailures++;
                await finishTool(scenarioCall,{ok:false,error:message});
                messages.push({role:"tool",content:JSON.stringify({ok:false,error:message}),tool_call_id:scenarioCall.id});
                if(consecutiveScenarioFailures>=MAX_VERIFICATION_ATTEMPTS)noteScenarioLimit();
              }
            }else{
              scenarioPending=false;
            }
          }else{
            // Диагностика, а не отказ: модель ещё не видела её и продолжает собирать проект.
            consecutiveVerifyFailures=countVerificationFailure(consecutiveVerifyFailures,"auto");
            verificationPending=true;
          }
        }

        // Asked once per run: a task that already changed files should be visible as a
        // plan. Waiting for the model to remember on its own would make the plan empty.
        if(!planSeen&&!planNudged&&(mutationSucceeded||(mode==="planner"&&step>=1&&!planning))){
          planNudged=true;
          messages.push({role:"system",content:mode==="planner"
            ? "NO PLAN PUBLISHED YET: in Planner mode the plan is the deliverable. Call plan.update now with the full ordered list of steps and their statuses, so the user can read and confirm it."
            : "NO USER-VISIBLE PLAN YET: this task already changed files, so the user cannot see the remaining steps. Call plan.update now with the complete ordered list of the remaining work, mark exactly one step 'in_progress', and keep the list current until every step is 'done'."});
        }
      }

      if(verificationPending)throw new Error("Достигнут лимит шагов агента, а изменения не проверены");
      if(scenarioPending)throw new Error("Достигнут лимит шагов агента, проверка в браузере не завершена");
      throw new Error("Достигнут лимит шагов агента");
    }catch(error){
      // Оборванный шаг: модель уже что-то написала или подумала, но шаг не завершился. Эта часть
      // живёт только в потоке, поэтому остановка или перезагрузка стирала бы её. Дописываем в
      // историю как есть — с пометкой ошибки у размышления, — и после перезагрузки незаконченный
      // ответ остаётся на месте, а не превращается в пустые строки.
      const partial=(error&&typeof error==="object"&&"partial" in error?(error as {partial?:{text?:string;reasoning?:string;step?:number;blockId?:string;startedAt?:string}}).partial:undefined);
      if(partial&&request.conversationId&&((partial.text??"").trim()||(partial.reasoning??"").trim())){
        const finishedAt=new Date().toISOString();
        const partialText=(partial.text??"").trim()?partial.text:"";
        const partialReasoning=(partial.reasoning??"").trim()?partial.reasoning:undefined;
        const partialBlock=partialReasoning?createReasoningBlock({
          ...(partial.blockId?{id:partial.blockId}:{}),
          runId,
          step:partial.step??1,
          text:partialReasoning,
          ...(partial.startedAt?{startedAt:partial.startedAt}:{}),
          finishedAt,
          status:"error",
        }):undefined;
        try{
          await appendConversationMessages(request.conversationId,[{
            role:"assistant",
            content:partialText??"",
            ...(partialReasoning?{reasoning:partialReasoning}:{}),
            ...(partialBlock?{reasoningBlocks:[partialBlock]}:{}),
          }]);
        }catch(persistError){console.error("Failed to persist the partial answer",persistError);}
      }
      // `code` lets the panel explain the failure (context size, provider key, rate limit) instead of
      // repeating a sentence the model wrote.
      const code=error&&typeof error==="object"&&"code" in error&&typeof (error as {code?:unknown}).code==="string"?(error as {code:string}).code:undefined;
      emit({type:"run.failed",runId,error:error instanceof Error?error.message:String(error),...(code?{code}:{})});
    }
    finally{
      endRun(request.projectId,request.conversationId);
      if(usageModel&&usageTotals.promptTokens>0){
        // Наблюдаемость без содержимого промпта: сколько входа пришло из кэша провайдера.
        // Ноль здесь — нормальный первый шаг, а не ошибка: кэш строится после первого запроса.
        const percent=Math.round(cacheHitRate(usageTotals.promptTokens,usageTotals.cachedPromptTokens)*100);
        const written=usageTotals.cacheWritePromptTokens>0 ? ", записано в кэш "+usageTotals.cacheWritePromptTokens : "";
        console.log("[cache] "+usageModel+": из кэша "+usageTotals.cachedPromptTokens+" из "+usageTotals.promptTokens+" входных токенов ("+percent+"%)"+written);
      }
      if(platformModel&&usageModel&&usageTotals.promptTokens+usageTotals.completionTokens>0){
        try{
          const credits=usageCreditRates?creditsForUsage(usageCreditRates,usageTotals.promptTokens,usageTotals.completionTokens):0;
          await recordRunUsage(request.userId,{runId,projectId:request.projectId,conversationId:request.conversationId,model:usageModel,modelId:usageModelId,promptTokens:usageTotals.promptTokens,completionTokens:usageTotals.completionTokens,cachedPromptTokens:usageTotals.cachedPromptTokens,credits,estimated:usageTotals.estimated});
        }catch(error){console.error("Failed to record run usage",error);}
      }
    }
  }
}
