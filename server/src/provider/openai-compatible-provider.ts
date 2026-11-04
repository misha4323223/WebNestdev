import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../types.js";
import { lines } from "./stream-lines.js";
import { ProviderHttpError,parseRetryAfterHeader } from "./provider-errors.js";
import type { Provider,ProviderChunk,ProviderStreamOptions,ProviderToolCall } from "./provider-types.js";
import { DsmlTextFilter } from "./dsml-tool-calls.js";
import type { ReasoningEffort } from "../types.js";
import {
  cacheUsageFromUsage,
  promptCachePolicy,
  promptCacheRequestFields,
  withPromptCacheControl,
} from "./prompt-caching.js";

function chatCompletionsUrl(baseUrl:string){
  const base=baseUrl.trim().replace(/\/+$/,"");
  return base.endsWith("/v1")
    ? base+"/chat/completions"
    : base+"/v1/chat/completions";
}

/**
 * Поле `provider` для шлюза. `only` — жёсткий белый список, `allow_fallbacks: false` запрещает
 * шлюзу самому уходить к другому провайдеру: иначе выбранный дешёвый Morph мог бы молча
 * замениться дорогим. Переключение делает RoutedProvider, когда провайдер выключен или отказал
 * до первого байта ответа.
 */
function upstreamRequestFields(options?:ProviderStreamOptions):Record<string,unknown>{
  const upstream=options?.upstream;
  if(!upstream||!upstream.only.length)return {};
  const maxPrice=upstream.maxPrice;
  const hasMaxPrice=Boolean(maxPrice&&(maxPrice.prompt!==undefined||maxPrice.completion!==undefined));
  return {
    provider:{
      only:upstream.only,
      allow_fallbacks:upstream.allowFallbacks,
      ...(hasMaxPrice?{max_price:{
        ...(maxPrice?.prompt!==undefined?{prompt:maxPrice.prompt}:{}),
        ...(maxPrice?.completion!==undefined?{completion:maxPrice.completion}:{}),
      }}:{}),
    },
  };
}

/**
 * Polza and some other gateways report an upstream refusal as an SSE event inside an HTTP 200
 * stream: `{error:{code:"TOO_MANY_REQUESTS"}, choices:[{delta:{content:""},finish_reason:"error"}]}`.
 * Without this check the parser sees a successful, empty stream and the user gets «Модель не вернула
 * ответ»; FailoverProvider never sees the refusal and cannot try the next provider. Map the gateway
 * code to the HTTP status ProviderHttpError already understands, so a rate-limited upstream is
 * retried or replaced instead of silently becoming an empty answer.
 */
function streamErrorResponse(data:any):{status:number;body:string}|null{
  const error=data?.error;
  const finish=data?.choices?.[0]?.finish_reason;
  if(!error&&finish!=="error")return null;
  const code=typeof error?.code==="string"?error.code:typeof error?.type==="string"?error.type:"";
  const message=typeof error==="string"?error:typeof error?.message==="string"?error.message:"";
  const normalized=(code+" "+message).toLowerCase();
  const status=/too_many_requests|rate[_ ]?limit|429/.test(normalized)?429
    :/unauthorized|invalid[_ ]?api[_ ]?key|authentication|401/.test(normalized)?401        :/insufficient|quota|payment|402/.test(normalized)?402
        :/context|too[_ ]?long|maximum.*token|token.*limit/.test(normalized)?400
          :/invalid|bad[_ ]?request|validation|not[_ ]?found|404/.test(normalized)?400
            :/service[_ ]?unavailable|overload|timeout|503|502|504/.test(normalized)?503
              :502;
  return {status,body:JSON.stringify({error:error??{code:"STREAM_ERROR",message:"Провайдер вернул ошибку в потоке"},choices:data?.choices})};
}

// AI-прокси: если задан AI_PROXY_URL, запрос идёт через зарубежный прокси.
const proxyUrl=(process.env.AI_PROXY_URL??"").replace(/\/+$/,"");
const proxyToken=(process.env.AI_PROXY_TOKEN??"").trim();

type WireToolCall={
  id:string;
  type:"function";
  function:{name:string;arguments:string};
};

type WireContentPart={type:"text";text:string;cache_control?:{type:"ephemeral"}};
type WireContent=string|WireContentPart[];
type WireMessage =
  | {role:"user"|"system";content:WireContent}
  | {role:"assistant";content:string;reasoning_content?:string;tool_calls?:WireToolCall[]}
  | {role:"tool";content:string;tool_call_id:string};

/**
 * The text of a reasoning field, whatever shape the gateway picked for it: a string, an object with
 * `text`/`content`/`summary`, or an array of such pieces. Guessing only the string form cost real
 * thinking on gateways that wrap it, and the failure is silent — the answer streams while the chain of
 * thought is dropped on the floor.
 */
function reasoningText(value:unknown):string{
  if(typeof value==="string")return value;
  if(Array.isArray(value))return value.map(reasoningText).join("");
  if(value&&typeof value==="object"){
    const item=value as {text?:unknown;content?:unknown;summary?:unknown;thinking?:unknown;reasoning?:unknown;thought?:unknown;value?:unknown};
    return reasoningText(item.text)||reasoningText(item.content)||reasoningText(item.summary)
      ||reasoningText(item.thinking)||reasoningText(item.reasoning)||reasoningText(item.thought)||reasoningText(item.value);
  }
  return "";
}

/** Все имена, которыми шлюзы называют цепочку рассуждений в одном чанке. */
const REASONING_FIELDS=["reasoning_content","reasoning","reasoning_details","reasoning_text","thinking","thought"] as const;

/**
 * Reasoning-capable models stream their chain of thought in one of several fields,
 * depending on the gateway: DeepSeek uses `reasoning_content`, Qwen `reasoning`, and a
 * few gateways send `reasoning_details`, `reasoning_text`, `thinking` or `thought`. Any of
 * them becomes a reasoning chunk. DeepSeek thinking mode is the exception to "show, never
 * send back": with tools it requires the earlier `reasoning_content` in the next request,
 * otherwise it either rejects the request or loses the thread and re-analyses the task.
 */
export function reasoningDelta(delta:unknown):string{
  if(!delta||typeof delta!=="object")return "";
  const value=delta as Record<string,unknown>;
  for(const field of REASONING_FIELDS){
    const text=reasoningText(value[field]);
    if(text)return text;
  }
  return "";
}

/**
 * Шлюзы отдают цепочку рассуждений только по просьбе: один и тот же адрес без `reasoning_effort`
 * присылает ответ и молчит о мыслях, а с ним — стримит их отдельным полем. Поэтому просим
 * по умолчанию; WEBNESTDEV_AI_REASONING=off выключает просьбу целиком, low/medium/high задают
 * глубину по умолчанию. Пользователь может выбрать глубину для конкретного запуска: `reasoning`
 * в запросе агента важнее настройки сервера. Шлюз, который такого поля не знает, отказывает с 400 —
 * тогда запуск не ломается, а повторяется без него (см. ниже), и пара «адрес + модель»
 * запоминается, чтобы не платить двумя запросами за шаг.
 */
const REASONING_REQUEST=(process.env.WEBNESTDEV_AI_REASONING??"medium").trim().toLowerCase();
/** `off` is an administrator decision: no request and no client choice re-enables it. */
const REASONING_ENABLED=!/^(off|0|false|no)$/i.test(REASONING_REQUEST);
const DEFAULT_REASONING_EFFORT:ReasoningEffort|null=["low","medium","high"].includes(REASONING_REQUEST)
  ?REASONING_REQUEST as ReasoningEffort
  :null;
/**
 * Что уже известно о глубине размышления у пары «адрес шлюза + модель». Одна и та же точка входа
 * обслуживает разные модели, и поле `reasoning_effort` принимают не все: поэтому память ведётся по
 * модели, а не по адресу — отказ одной модели не должен выключать глубину для соседней.
 *
 * Наблюдений два, и они не одно и то же: шлюз может принять поле и всё равно не прислать цепочку
 * рассуждений (обычная чат-модель его игнорирует). Отсюда четыре состояния в `reasoningSupport`.
 */
type ReasoningProbe={accepted:boolean|null;streamed:boolean;checkedAt:number};
const reasoningProbes=new Map<string,ReasoningProbe>();

/**
 * `confirmed` — рассуждения пришли; `silent` — поле принято, но мыслей в ответе нет;
 * `rejected` — шлюз отказал формой (400/422) и запрос повторяется без поля; `unknown` — ещё не
 * проверяли. `enabled=false` — глубину выключил администратор (`WEBNESTDEV_AI_REASONING=off`).
 */
export type ReasoningSupportStatus="confirmed"|"silent"|"rejected"|"unknown";
export type ReasoningSupport={enabled:boolean;effort:ReasoningEffort|null;status:ReasoningSupportStatus;checkedAt:string|null};

function probeKey(baseUrl:string,model:string){
  return baseUrl.trim().replace(/\/+$/,"")+"|"+model.trim();
}

function recordProbe(key:string,patch:{accepted?:boolean;streamed?:boolean}){
  const current=reasoningProbes.get(key)??{accepted:null,streamed:false,checkedAt:Date.now()};
  reasoningProbes.set(key,{
    accepted:patch.accepted??current.accepted,
    streamed:patch.streamed??current.streamed,
    checkedAt:Date.now()
  });
}

/** Поддержка глубины для конкретной модели: по ней настройки провайдера рисуют индикатор. */
export function reasoningSupport(baseUrl:string,model:string):ReasoningSupport{
  const probe=reasoningProbes.get(probeKey(baseUrl,model));
  const status:ReasoningSupportStatus=!REASONING_ENABLED||!probe
    ?"unknown"
    :probe.accepted===false?"rejected"
    :probe.streamed?"confirmed"
    :"silent";
  return {enabled:REASONING_ENABLED,effort:DEFAULT_REASONING_EFFORT,status,checkedAt:probe?new Date(probe.checkedAt).toISOString():null};
}

/** Тестам нужна чистая память: отказ или успех одного прогона не должен влиять на следующий. */
export function resetReasoningProbes(){reasoningProbes.clear();}

/** Depth chosen for this run, or the server default when the client did not choose one. */
function reasoningEffort(options?:ProviderStreamOptions):ReasoningEffort|null{
  if(!REASONING_ENABLED)return null;
  return options?.reasoning??DEFAULT_REASONING_EFFORT;
}

/**
 * A gateway that keeps its chain of thought under an undocumented field is diagnosed from the stream
 * itself rather than guessed at: with `AI_STREAM_DEBUG=1` the first chunks of every request report the
 * field names of `delta` — names only, the text of the answer is not logged — so where the reasoning
 * hides is visible in the server log.
 */
const STREAM_DEBUG=/^(1|true|yes|on)$/i.test((process.env.AI_STREAM_DEBUG??"").trim());
const STREAM_DEBUG_CHUNKS=20;

/**
 * DeepSeek's thinking mode is the one provider that must receive its previous chain of thought
 * back. The official API requires `reasoning_content` on earlier assistant turns when tools are in
 * play; Polza exposes the same model under a `deepseek/...` id. Other OpenAI-compatible gateways
 * reject an unknown assistant field or bill it as ordinary input, so the passback stays conditional.
 */
export function reasoningPassbackSupported(baseUrl:string,model:string){
  const id=model.trim().toLowerCase();
  return id.includes("deepseek")||baseUrl.trim().toLowerCase().includes("deepseek.com");
}

export function toWireMessages(messages:ChatMessage[],options?:{reasoningPassthrough?:boolean}):WireMessage[]{
  return messages.map(message=>{
    if(message.role==="assistant"){
      // Only a DeepSeek thinking request gets the field, and it is always present there: once a
      // request carries tools, the API requires `reasoning_content` on every previous assistant
      // turn — including turns that did not call a tool. An absent field is a 400, while an empty
      // string is the honest value for a turn whose chain was not streamed.
      const reasoning=options?.reasoningPassthrough
        ?{reasoning_content:message.reasoning??""}
        :{};
      if(!message.tool_calls?.length){
        return {role:"assistant",content:message.content,...reasoning};
      }
      return {
      role:"assistant",
      content:message.content,
      ...reasoning,
      tool_calls:message.tool_calls.map(call=>({
        id:call.id,
        type:"function",
        function:{
          name:call.name,
          arguments:JSON.stringify(call.arguments??{})
        }
      }))
      };
    }
    return message;
  });
}

export class OpenAICompatibleProvider implements Provider{
  constructor(private base:string,private key?:string){}

  async *stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal,options?:ProviderStreamOptions):AsyncGenerator<ProviderChunk>{
    const targetUrl=chatCompletionsUrl(this.base);
    // Для прокси: шлём только суффикс (без домена), target идёт в X-AI-Proxy-Target.
    // Если base оканчивается на /v1 — суффикс /chat/completions, иначе /v1/chat/completions.
    // Так склейка на стороне прокси всегда корректная (нет дублей /v1/v1 и /api/v1/api/v1).
    const normBase=this.base.trim().replace(/\/+$/,"");
    const chatPath=normBase.endsWith("/v1")?"/chat/completions":"/v1/chat/completions";
    // Кэш провайдера: DeepSeek/OpenAI/Gemini/Grok кэшируют префикс сами, Claude требует
    // явные точки. Разметка не меняет обычные сообщения и не отправляется шлюзам, которые
    // такого формата не знают (prompt-caching.ts).
    const cachePolicy=promptCachePolicy(normBase,model);
    const wireOptions={reasoningPassthrough:reasoningPassbackSupported(normBase,model)};
    const wire=cachePolicy.mode==="explicit"
      ? withPromptCacheControl(toWireMessages(messages,wireOptions))
      : toWireMessages(messages,wireOptions);
    const cacheFields=promptCacheRequestFields(cachePolicy,options?.cacheKey);
    const send=(body:unknown)=>proxyUrl
      ? fetch(proxyUrl+chatPath,{
        method:"POST",
        signal,
        headers:{
          "content-type":"application/json",
          "x-ai-proxy-target":normBase,
          ...(proxyToken?{"x-proxy-token":proxyToken}:{}),
          ...(this.key?{authorization:"Bearer "+this.key}:{})
        },
        body:JSON.stringify(body)
      })
      : fetch(targetUrl,{
        method:"POST",
        signal,
        headers:{
          "content-type":"application/json",
          ...(this.key?{authorization:"Bearer "+this.key}:{})
        },
        body:JSON.stringify(body)
      });
    const effort=reasoningEffort(options);
    const key=probeKey(normBase,model);
    const upstreamFields=upstreamRequestFields(options);
    const payload=(withReasoning:boolean)=>({model,messages:wire,tools,stream:true,...cacheFields,...upstreamFields,...(withReasoning&&effort?{reasoning_effort:effort}:{})});
    // Мысли нужны пользователю, но не настолько, чтобы сломать запуск: шлюз, отвечающий на просьбу
    // о рассуждении отказом формы (400/422), получает тот же запрос без неё — и запоминается, чтобы
    // следующие шаги запуска не платили за это двумя запросами каждый.
    const askReasoning=Boolean(effort)&&reasoningProbes.get(key)?.accepted!==false;
    let withReasoning=askReasoning;
    let response=await send(payload(withReasoning));
    if(!response.ok&&withReasoning&&(response.status===400||response.status===422)){
      try{await response.body?.cancel()}catch{}
      recordProbe(key,{accepted:false});
      withReasoning=false;
      response=await send(payload(false));
    }
    // Принятое поле — тоже наблюдение: по нему индикатор в настройках отличает «шлюз понимает
    // глубину» от «ещё не проверяли». Отсутствие рассуждений в ответе сохраняет статус `silent`.
    if(response.ok&&withReasoning)recordProbe(key,{accepted:true});
    if(!response.ok){
      const detail=await response.text().catch(()=>"");
      // Типизированная ошибка: переполнение контекста рантайм умеет лечить повтором с меньшим
      // контекстом, остальные коды объясняются пользователю по-человечески (provider-errors.ts).
      // Подсказка Retry-After едет вместе с ошибкой: по ней шаг решает, сколько подождать, прежде
      // чем повторить запрос, вместо того чтобы падать на лимите частоты (provider-retry.ts).
      throw new ProviderHttpError(response.status,detail,parseRetryAfterHeader(response.headers.get("retry-after")));
    }
    if(!response.body)throw new Error("Провайдер не вернул поток данных");

    const pending=new Map<number,ProviderToolCall>();
    const recovered:ProviderToolCall[]=[];
    const dsml=new DsmlTextFilter(tools);
    let debugged=0;
    // Шлюз называет фактического провайдера в корне ответа. Лог подтверждает выбор: при `auto`
    // это единственное место, где видно, кто на самом деле обслужил запрос.
    let upstreamLogged=false;
    // Шлюзы делятся надвое: одни стримят размышление чанками, другие присылают его готовым
    // сообщением в последнем чанке. Флаг не даёт показать одно и то же дважды.
    let sawReasoning=false;
    for await(const line of lines(response.body)){
      if(!line||line==="[DONE]")continue;
      const data=JSON.parse(line) as any;
      const streamError=streamErrorResponse(data);
      if(streamError)throw new ProviderHttpError(streamError.status,streamError.body,parseRetryAfterHeader(response.headers.get("retry-after")));
      if(!upstreamLogged&&typeof data.provider==="string"&&data.provider){
        upstreamLogged=true;
        console.log("[provider] "+model+" обслужил "+data.provider);
      }
      if(data.usage){
        // `cachedPromptTokens` — не отдельный счётчик денег, а расшифровка уже полученного
        // prompt_tokens: Polza/DeepSeek/OpenAI называют кэш по-разному, разбор один.
        yield {type:"usage",promptTokens:Number(data.usage.prompt_tokens??0),completionTokens:Number(data.usage.completion_tokens??0),...cacheUsageFromUsage(data.usage)};
      }
      const delta=data.choices?.[0]?.delta;
      if(STREAM_DEBUG&&delta&&debugged<STREAM_DEBUG_CHUNKS){
        debugged++;
        const names=Object.keys(delta);
        console.error("[provider] AI_STREAM_DEBUG: модель "+model+", чанк "+debugged+", поля delta — "+(names.join(", ")||"(пусто)")+
          (names.some(name=>/reason/i.test(name))?" [есть поле с reasoning, но текст не разобран]":""));
      }
      if(delta?.content){
        const filtered=dsml.push(delta.content);
        if(filtered.text)yield {type:"text",text:filtered.text};
        recovered.push(...filtered.calls);
      }
      const reasoning=reasoningDelta(delta);
      if(reasoning){
        sawReasoning=true;
        yield {type:"reasoning",text:reasoning};
      }
      if(!sawReasoning){
        const whole=reasoningDelta(data.choices?.[0]?.message);        if(whole){
          sawReasoning=true;
          yield {type:"reasoning",text:whole};
        }
      }
      for(const call of delta?.tool_calls??[]){
        const index=call.index??0;
        const existing=pending.get(index)??{
          id:call.id??randomUUID(),
          name:call.function?.name??"",
          arguments:{}
        };
        if(call.id)existing.id=call.id;
        if(call.function?.name)existing.name=call.function.name;
        const fragment=call.function?.arguments;
        if(fragment){
          const raw=(existing as any).__raw??"";
          (existing as any).__raw=raw+fragment;
          try{existing.arguments=JSON.parse((existing as any).__raw)}catch{}
        }
        pending.set(index,existing);
      }
    }
    if(sawReasoning)recordProbe(key,{streamed:true});
    const tail=dsml.flush();
    if(tail.text)yield {type:"text",text:tail.text};
    recovered.push(...tail.calls);
    // A structured call wins over a recovered copy of the same call: some gateways send
    // both the parsed field and the raw DSML tail. Dedupe by name and arguments, not by id,
    // because the recovered call gets a new local id.
    const seen=new Set<string>();
    for(const call of [...pending.values(),...recovered]){
      delete (call as any).__raw;
      const key=call.name+"|"+JSON.stringify(call.arguments??{});
      if(seen.has(key))continue;
      seen.add(key);
      yield {type:"tool_call",call};
    }
    yield {type:"done"};
  }
}
