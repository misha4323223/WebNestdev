import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../types.js";
import { lines } from "./stream-lines.js";
import { ProviderHttpError,parseRetryAfterHeader } from "./provider-errors.js";
import type { Provider,ProviderChunk,ProviderToolCall } from "./provider-types.js";

function chatCompletionsUrl(baseUrl:string){
  const base=baseUrl.trim().replace(/\/+$/,"");
  return base.endsWith("/v1")
    ? base+"/chat/completions"
    : base+"/v1/chat/completions";
}

// AI-прокси: если задан AI_PROXY_URL, запрос идёт через зарубежный прокси.
const proxyUrl=(process.env.AI_PROXY_URL??"").replace(/\/+$/,"");
const proxyToken=(process.env.AI_PROXY_TOKEN??"").trim();

type WireToolCall={
  id:string;
  type:"function";
  function:{name:string;arguments:string};
};

type WireMessage=
  | {role:"user"|"system";content:string}
  | {role:"assistant";content:string;tool_calls?:WireToolCall[]}
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
 * them becomes a reasoning chunk. It is shown to the user and never sent back to the provider.
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
 * глубину. Шлюз, который такого поля не знает, отказывает с 400 — тогда запуск не ломается, а
 * повторяется без него (см. ниже), и адрес запоминается, чтобы не платить двумя запросами за шаг.
 */
const REASONING_REQUEST=(process.env.WEBNESTDEV_AI_REASONING??"medium").trim().toLowerCase();
const REASONING_EFFORT=["low","medium","high"].includes(REASONING_REQUEST)?REASONING_REQUEST:null;
const reasoningRejected=new Set<string>();

/**
 * A gateway that keeps its chain of thought under an undocumented field is diagnosed from the stream
 * itself rather than guessed at: with `AI_STREAM_DEBUG=1` the first chunks of every request report the
 * field names of `delta` — names only, the text of the answer is not logged — so where the reasoning
 * hides is visible in the server log.
 */
const STREAM_DEBUG=/^(1|true|yes|on)$/i.test((process.env.AI_STREAM_DEBUG??"").trim());
const STREAM_DEBUG_CHUNKS=20;

export function toWireMessages(messages:ChatMessage[]):WireMessage[]{
  return messages.map(message=>{
    if(message.role==="assistant"){
      if(!message.tool_calls?.length){
        return {role:"assistant",content:message.content};
      }
      return {
      role:"assistant",
      content:message.content,
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

  async *stream(messages:ChatMessage[],model:string,tools?:unknown[],signal?:AbortSignal):AsyncGenerator<ProviderChunk>{
    const targetUrl=chatCompletionsUrl(this.base);
    // Для прокси: шлём только суффикс (без домена), target идёт в X-AI-Proxy-Target.
    // Если base оканчивается на /v1 — суффикс /chat/completions, иначе /v1/chat/completions.
    // Так склейка на стороне прокси всегда корректная (нет дублей /v1/v1 и /api/v1/api/v1).
    const normBase=this.base.trim().replace(/\/+$/,"");
    const chatPath=normBase.endsWith("/v1")?"/chat/completions":"/v1/chat/completions";
    const wire=toWireMessages(messages);
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
    const payload=(withReasoning:boolean)=>({model,messages:wire,tools,stream:true,...(withReasoning&&REASONING_EFFORT?{reasoning_effort:REASONING_EFFORT}:{})});
    // Мысли нужны пользователю, но не настолько, чтобы сломать запуск: шлюз, отвечающий на просьбу
    // о рассуждении отказом формы (400/422), получает тот же запрос без неё — и запоминается, чтобы
    // следующие шаги запуска не платили за это двумя запросами каждый.
    const askReasoning=Boolean(REASONING_EFFORT)&&!reasoningRejected.has(normBase);
    let response=await send(payload(askReasoning));
    if(!response.ok&&askReasoning&&(response.status===400||response.status===422)){
      try{await response.body?.cancel()}catch{}
      reasoningRejected.add(normBase);
      response=await send(payload(false));
    }
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
    let debugged=0;
    // Шлюзы делятся надвое: одни стримят размышление чанками, другие присылают его готовым
    // сообщением в последнем чанке. Флаг не даёт показать одно и то же дважды.
    let sawReasoning=false;
    for await(const line of lines(response.body)){
      if(!line||line==="[DONE]")continue;
      const data=JSON.parse(line) as any;
      if(data.usage){
        yield {type:"usage",promptTokens:Number(data.usage.prompt_tokens??0),completionTokens:Number(data.usage.completion_tokens??0)};
      }
      const delta=data.choices?.[0]?.delta;
      if(STREAM_DEBUG&&delta&&debugged<STREAM_DEBUG_CHUNKS){
        debugged++;
        const names=Object.keys(delta);
        console.error("[provider] AI_STREAM_DEBUG: модель "+model+", чанк "+debugged+", поля delta — "+(names.join(", ")||"(пусто)")+
          (names.some(name=>/reason/i.test(name))?" [есть поле с reasoning, но текст не разобран]":""));
      }
      if(delta?.content)yield {type:"text",text:delta.content};
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
    for(const call of pending.values()){
      delete (call as any).__raw;
      yield {type:"tool_call",call};
    }
    yield {type:"done"};
  }
}
