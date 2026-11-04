import type { AgentRunRequest,ChatMessage,ScoutKind,ScoutRequest,ScoutResult,ScoutRunner } from "../types.js";
import type { Provider } from "../provider.js";
import type { AgentContext,EventSink } from "./types.js";
import type { StepBudget,StepUsage } from "./step-runner.js";
import { runBudgetedStep } from "./step-runner.js";
import { executeTool } from "./tool-executor.js";
import { boundToolOutput,DEFAULT_CHARS_PER_TOKEN } from "./context-budget.js";

/**
 * Read-only разведчик: отдельный маленький запуск, который читает проект или публичные страницы
 * и возвращает факты основному агенту.
 *
 * Зачем он нужен. Основной запуск держит один растущий контекст: каждый прочитанный файл остаётся
 * в истории до конца задачи, даже если ответ на вопрос занял одну строку. Разведчик платит за это
 * только своим контекстом и возвращает короткий JSON — то есть работает как отдельный поиск, а не
 * как ещё одна ветка основного разговора.
 *
 * Профили. `code` ищет по исходникам проекта, `web` — по публичным страницам, когда пользователь
 * включил поиск в интернете. Инструменты и промпт у профилей разные, но цикл, бюджет, учёт
 * токенов и защита от изменений общие.
 *
 * Что он не может. Набор инструментов здесь — белый список только для чтения, и `executeTool`
 * проверяет его повторно. `agent.scout` в список не входит, поэтому разведчик не может позвать
 * другого разведчика: рекурсия стоила бы токенов и ничего не добавляла.
 */
export const SCOUT_CODE_TOOLS = [
  "project.list_files", "project.stat",
  "fs.list", "fs.read", "fs.grep", "fs.outline",
  "git.status", "git.diff",
] as const;
export const SCOUT_WEB_TOOLS = ["web.search", "web.read"] as const;
/** Прежнее имя профиля по коду: на него опираются тесты и внешние вызовы. */
export const SCOUT_TOOLS = SCOUT_CODE_TOOLS;
const SCOUT_TOOL_SETS: Record<ScoutKind,Set<string>> = {
  code: new Set<string>(SCOUT_CODE_TOOLS),
  web: new Set<string>(SCOUT_WEB_TOOLS),
};

/** Разведка должна быть короткой: обычный ответ находится за 2–4 шага. */
export const SCOUT_MAX_STEPS=6;
/** Свой потолок контекста: чужие шаги основного запуска в него не попадают. */
export const SCOUT_BUDGET_TOKENS=60_000;
export const SCOUT_MAX_MESSAGES=24;
/**
 * Один результат инструмента в контексте разведчика. `boundToolOutput` рассчитан на основной
 * запуск и для `fs.read` оставляет 24 000 символов; разведчику хватает меньшего, а окно он
 * запрашивает сам через lineStart/lineLimit.
 */
const SCOUT_TOOL_OUTPUT_CHARS=6_000;
// Ответ должен быть короче прочитанного, иначе разведка не экономит контекст. Эти пределы
// складываются примерно в 12 000 символов — столько же, сколько разрешено выводу инструмента
// в context-budget.ts, поэтому типичный JSON не обрезается посередине.
const SCOUT_SUMMARY_CHARS=2_400;
const SCOUT_MAX_FILES=24;
const SCOUT_FILE_CHARS=300;
const SCOUT_MAX_FINDINGS=12;
const SCOUT_FINDING_CHARS=400;
const SCOUT_MAX_SOURCES=16;
const SCOUT_SOURCE_CHARS=600;
/**
 * `agent.scout` отдаётся основному агенту через `boundToolOutput`, где для него стоит предел
 * 12 000 символов. Сумма независимых лимитов выше этого предела, а обрезанный посередине JSON —
 * не просто шум: модель не сможет его разобрать и потратит шаг на повторный вызов.
 * Поэтому готовый ответ укладывается в бюджет целиком, с запасом на JSON-экранирование.
 */
const SCOUT_RESULT_CHARS=11_500;

export const SCOUT_WEB_DISABLED_MESSAGE =
  "Веб-разведка недоступна: поиск в интернете выключен. Включите «Поиск в интернете» в меню «Режимы» у поля ввода и повторите запрос.";

const SCOUT_CODE_PROMPT=[
  "Ты — read-only субагент-разведчик основного агента. Твоя работа — прочитать проект и вернуть факты, а не менять его.",
  "Доступны только инструменты чтения: project.list_files, project.stat, fs.list, fs.read, fs.grep, fs.outline, git.status, git.diff. Любой другой вызов будет отклонён.",
  "Работай прицельно: сначала fs.grep или fs.outline, затем окна fs.read с lineStart/lineLimit. Не читай файлы целиком без необходимости и не повторяй один и тот же запрос.",
  "В конце верни ТОЛЬКО один JSON-объект, без markdown и без пояснений вокруг него:",
  '{"summary":"краткий ответ на вопрос","files":["точные/пути"],"findings":["факт с путём и символом"]}',
  "Пиши summary и findings на языке задачи (по-русски, если задача на русском). Не выдумывай: если факта нет в файлах, так и напиши.",
].join("\n");

const SCOUT_WEB_PROMPT=[
  "Ты — read-only субагент-разведчик основного агента. Твоя работа — найти внешние факты в интернете и вернуть короткий ответ, а не менять проект.",
  "Доступны только web.search и web.read. Сначала ищи через web.search, затем читай через web.read одну-три самые релевантные страницы. Не открывай десяток ссылок и не повторяй один и тот же запрос.",
  "Если поиск вернул ok:false (disabled, quota, blocked, unavailable), это факт, а не повод угадывать: верни причину в findings и не выдумывай ответ по памяти.",
  "В конце верни ТОЛЬКО один JSON-объект, без markdown и без пояснений вокруг него:",
  '{"summary":"краткий ответ на вопрос","files":[],"findings":["факт с указанием источника"],"sources":["https://адрес-прочитанной-страницы"]}',
  "В sources только реально прочитанные http(s)-адреса. Пиши summary и findings на языке задачи (по-русски, если задача на русском).",
].join("\n");

type ScoutProfile={prompt:string;tools:readonly string[];disallowed:string};
const SCOUT_PROFILES:Record<ScoutKind,ScoutProfile>={
  code:{prompt:SCOUT_CODE_PROMPT,tools:SCOUT_CODE_TOOLS,disallowed:"он только читает проект"},
  web:{prompt:SCOUT_WEB_PROMPT,tools:SCOUT_WEB_TOOLS,disallowed:"он только ищет и читает публичные страницы"},
};

function scoutTaskMessage(input:ScoutRequest){
  const focus=input.focus?.trim();
  return "ЗАДАЧА ОСНОВНОГО АГЕНТА:\n"+input.task.trim()+"\n\nФОКУС РАЗВЕДКИ:\n"+
    (focus||"найди минимальный набор фактов, который нужен для этой задачи");
}

function stringList(value:unknown,limit:number,maxChars:number){
  if(!Array.isArray(value))return [];
  const result:string[]=[];
  for(const item of value){
    if(typeof item!=="string")continue;
    const text=item.trim();
    if(!text)continue;
    result.push(text.slice(0,maxChars));
    if(result.length>=limit)break;
  }
  return result;
}

function httpSources(value:unknown){
  return [...new Set(stringList(value,SCOUT_MAX_SOURCES,SCOUT_SOURCE_CHARS))]
    .filter(url=>/^https?:\/\//i.test(url));
}

/** Один и тот же адрес в разных формах: без якоря и без завершающего слеша. */
function sourceKey(url:string){
  try{
    const parsed=new URL(url);
    parsed.hash="";
    return parsed.toString().replace(/\/$/,"");
  }catch{return url}
}

/**
 * Оставляет в `sources` только те страницы, которые разведчик действительно открыл. Модель может
 * перечислить красивые адреса из сниппетов поиска или просто по памяти; такой список выглядел бы
 * как проверенные источники, хотя страницы никто не читал.
 */
function keepReadSources(result:ScoutResult,read:Set<string>):ScoutResult{
  if(!result.sources?.length)return result;
  const sources=result.sources.filter(url=>read.has(sourceKey(url)));
  if(sources.length)return {...result,sources};
  const {sources:_unread,...rest}=result;
  void _unread;
  return rest;
}

/**
 * Убирает из результата целые хвостовые элементы, пока он не поместится в бюджет инструмента.
 * Резать строку пополам нельзя: битый JSON или обрезанный URL хуже, чем меньше фактов.
 */
function fitScoutResult(result:ScoutResult):ScoutResult{
  const fitted:ScoutResult={
    ...result,
    files:[...result.files],
    findings:[...result.findings],
    ...(result.sources?{sources:[...result.sources]}:{}),
  };
  const size=()=>JSON.stringify(fitted).length;
  while(size()>SCOUT_RESULT_CHARS){
    if(fitted.findings.length>1){fitted.findings.pop();continue;}
    if(fitted.files.length>1){fitted.files.pop();continue;}
    if(fitted.sources&&fitted.sources.length>1){fitted.sources.pop();continue;}
    // Последний случай — только очень длинное summary; обрезаем его, сохраняя начало ответа.
    if(fitted.summary.length>200){
      fitted.summary=fitted.summary.slice(0,Math.max(200,fitted.summary.length-200))+"…";
      continue;
    }
    break;
  }
  return fitted;
}

/**
 * Разбирает ответ модели. Модель иногда оборачивает JSON в ```json, а иногда отвечает обычным
 * текстом — оба варианта должны дойти до основного агента, а не превратиться в ошибку разбора.
 */
export function parseScoutResult(text:string):ScoutResult{
  const raw=(text??"").trim();
  if(!raw)return {ok:false,summary:"Разведчик не вернул ответ.",files:[],findings:[]};
  const cleaned=raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  const from=cleaned.indexOf("{");
  const to=cleaned.lastIndexOf("}");
  if(from>=0&&to>from){
    try{
      const value=JSON.parse(cleaned.slice(from,to+1)) as Record<string,unknown>;
      const summary=typeof value.summary==="string"?value.summary.trim():"";
      if(summary){
        const sources=httpSources(value.sources);
        return fitScoutResult({
          ok:true,
          summary:summary.slice(0,SCOUT_SUMMARY_CHARS),
          files:[...new Set(stringList(value.files,SCOUT_MAX_FILES,SCOUT_FILE_CHARS))],
          findings:stringList(value.findings,SCOUT_MAX_FINDINGS,SCOUT_FINDING_CHARS),
          ...(sources.length?{sources}:{}),
        });
      }
    }catch{
      // Не JSON — ниже вернём текст как summary: он всё равно полезнее пустого ответа.
    }
  }
  return fitScoutResult({ok:true,summary:cleaned.slice(0,SCOUT_SUMMARY_CHARS),files:[],findings:[]});
}

function scoutToolOutput(name:string,output:unknown){
  const text=boundToolOutput(name,output);
  return text.length>SCOUT_TOOL_OUTPUT_CHARS
    ? text.slice(0,SCOUT_TOOL_OUTPUT_CHARS)+"\n…[вывод сокращён; запроси более узкий фрагмент]"
    : text;
}

export type ScoutRunnerOptions={
  provider:Provider;
  model:string;
  runId:string;
  request:AgentRunRequest;
  emit:EventSink;
  signal?:AbortSignal;
  maxSteps?:number;
  budget?:StepBudget;
  /** Расход разведчика идёт в общий журнал запуска: токены потрачены одной задачей. */
  onUsage?:(usage:StepUsage)=>void;
};

/**
 * Создаёт runner один раз на запуск. История и счётчик шагов живут внутри каждого вызова,
 * поэтому два вопроса подряд не смешивают прочитанное. Настройка бюджета общая: если провайдер
 * один раз отказал по размеру, следующая разведка не должна повторять тот же отказ.
 */
export function createScoutRunner(options:ScoutRunnerOptions):ScoutRunner{
  const maxSteps=Math.max(1,Math.floor(options.maxSteps??SCOUT_MAX_STEPS));
  const budget:StepBudget=options.budget??{
    budgetTokens:SCOUT_BUDGET_TOKENS,
    charsPerToken:DEFAULT_CHARS_PER_TOKEN,
    maxMessages:SCOUT_MAX_MESSAGES,
  };
  // Провайдер может откалибровать оценку или уменьшить потолок после отказа — это решение
  // должно пережить шаг разведчика, иначе следующий запрос снова упрётся в ту же стену.
  let currentBudget:StepBudget={...budget};
  // Разведчик работает внутри запуска, но его шаги не должны появляться в переписке как ответы
  // основного агента. Наружу идёт только ожидание лимита провайдера; инструменты разведчика
  // показываются одним вызовом agent.scout.
  const scoutEmit:EventSink=event=>{
    if(event.type==="run.retrying")options.emit(event);
  };

  return async(input:ScoutRequest):Promise<ScoutResult>=>{
    const task=input?.task?.trim();
    if(!task)throw new Error("agent.scout: нужна задача для разведки");
    const kind=input.kind??"code";
    const profile=SCOUT_PROFILES[kind];
    if(!profile)throw new Error("agent.scout: неизвестный профиль разведки: "+String(kind));
    // Без разрешения пользователя веб-профиль не должен даже начинать запрос: поиск — это
    // отдельное решение человека, а не побочный эффект разведки.
    if(kind==="web"&&options.request.webSearch!==true)throw new Error(SCOUT_WEB_DISABLED_MESSAGE);
    const allowedTools=SCOUT_TOOL_SETS[kind];
    // Какие страницы профиль действительно открыл: по этому набору проверяются sources.
    const readSources=new Set<string>();
    const messages:ChatMessage[]=[
      {role:"system",content:profile.prompt},
      {role:"user",content:scoutTaskMessage({task,...(input.focus?.trim()?{focus:input.focus.trim()}:{})})},
    ];
    let lastText="";
    const contextFor=(step:number,toolNames:readonly string[]):AgentContext=>({
      runId:options.runId,
      request:options.request,
      emit:scoutEmit,
      ...(options.signal?{signal:options.signal}:{}),
      step,
      toolNames,
      // Разведка — механическая работа: глубокое рассуждение здесь дороже, чем полезно.
      reasoning:"low",
    });

    for(let step=1;step<=maxSteps;step++){
      if(options.signal?.aborted)throw new Error("Запуск агента отменён");
      const run=await runBudgetedStep(options.provider,messages,options.model,contextFor(step,profile.tools),currentBudget);
      currentBudget=run.budget;
      options.onUsage?.(run.result.usage);
      if(run.result.text.trim())lastText=run.result.text;
      if(!run.result.calls.length)return keepReadSources(parseScoutResult(run.result.text),readSources);

      messages.push({
        role:"assistant",
        content:run.result.text,
        tool_calls:run.result.calls,
        ...(run.result.reasoning?{reasoning:run.result.reasoning}:{}),
      });

      for(const call of run.result.calls){
        if(options.signal?.aborted)throw new Error("Запуск агента отменён");
        // Вторая линия защиты: даже если модель придумала имя, до реестра изменяющий инструмент
        // не дойдёт. Ответ — обычный tool-результат, чтобы разведчик мог исправиться следующим шагом.
        if(!allowedTools.has(call.name)){
          messages.push({
            role:"tool",
            content:JSON.stringify({error:"Инструмент "+call.name+" недоступен этому профилю разведчика: "+profile.disallowed+". Доступны: "+profile.tools.join(", ")+"."}),
            tool_call_id:call.id,
          });
          continue;
        }
        try{
          const output=await executeTool(call,contextFor(step,profile.tools));
          if(call.name==="web.read"){
            const requested=(call.arguments as {url?:unknown}|null)?.url;
            if(typeof requested==="string")readSources.add(sourceKey(requested));
            const page=output as {ok?:unknown;url?:unknown}|null;
            if(page?.ok===true&&typeof page.url==="string")readSources.add(sourceKey(page.url));
          }
          messages.push({role:"tool",content:scoutToolOutput(call.name,output),tool_call_id:call.id});
        }catch(error){
          const message=error instanceof Error?error.message:String(error);
          messages.push({role:"tool",content:JSON.stringify({error:message}),tool_call_id:call.id});
        }
      }
    }

    // Лимит шагов — не потеря результата: один финальный запрос без инструментов заставляет
    // модель сформулировать итог по уже прочитанному. Это единственный выход за maxSteps, и он
    // не тратит шаг на чтение.
    messages.push({
      role:"system",
      content:"ЛИМИТ ШАГОВ РАЗВЕДКИ ИСЧЕРПАН ("+maxSteps+"). Не вызывай инструменты. Сформулируй итог только по уже прочитанному и верни JSON с summary, files, findings и sources.",
    });
    const summary=await runBudgetedStep(options.provider,messages,options.model,contextFor(maxSteps+1,[]),currentBudget);
    options.onUsage?.(summary.result.usage);
    if(summary.result.text.trim()){
      const parsed=keepReadSources(parseScoutResult(summary.result.text),readSources);
      const note="Разведка остановлена по лимиту шагов ("+maxSteps+"): часть источников могла остаться непрочитанной.";
      return fitScoutResult({
        ...parsed,
        // Заметка идёт первой: если результат придётся сокращать, она не пропадёт вместе с хвостом.
        findings:[note,...parsed.findings].slice(0,SCOUT_MAX_FINDINGS),
      });
    }
    const fallback=lastText.trim()||"Разведчик не успел вернуть итог за "+maxSteps+" шагов.";
    return {
      ok:false,
      summary:fallback.slice(0,SCOUT_SUMMARY_CHARS),
      files:[],
      findings:["Разведка остановлена по лимиту шагов ("+maxSteps+")."],
    };
  };
}
