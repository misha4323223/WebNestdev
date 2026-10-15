import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider, reasoningDelta, toWireMessages } from "./openai-compatible-provider.js";
import type { ProviderChunk } from "./provider-types.js";
import type { ChatMessage } from "../types.js";

test("converts assistant tool calls to Chat Completions wire format",()=>{
  const messages:ChatMessage[]=[
    {role:"user",content:"create a file"},
    {
      role:"assistant",
      content:"",
      tool_calls:[{
        id:"call_123",
        name:"fs.write",
        arguments:{path:"src/test.ts",content:"export const ok=true;"}
      }]
    },
    {role:"tool",tool_call_id:"call_123",content:"ok"}
  ];

  assert.deepEqual(toWireMessages(messages),[
    {role:"user",content:"create a file"},
    {
      role:"assistant",
      content:"",
      tool_calls:[{
        id:"call_123",
        type:"function",
        function:{
          name:"fs.write",
          arguments:'{"path":"src/test.ts","content":"export const ok=true;"}'
        }
      }]
    },
    {role:"tool",tool_call_id:"call_123",content:"ok"}
  ]);
});

// Размышления приходят под разными именами и в разной упаковке, и промах здесь тихий: ответ
// стримится, а цепочка рассуждений просто пропадает. Поэтому принимаем все известные формы.
test("рассуждение читается из любого поля, которым шлюз его называет",()=>{
  assert.equal(reasoningDelta({reasoning_content:"шаг 1"}),"шаг 1");
  assert.equal(reasoningDelta({reasoning:"шаг 2"}),"шаг 2");
  // Шлюзы, которые упаковывают рассуждение в объект, а не в строку.
  assert.equal(reasoningDelta({reasoning:{text:"шаг 3"}}),"шаг 3");
  assert.equal(reasoningDelta({reasoning_details:[{text:"а"},{content:"б"}]}),"аб");
  assert.equal(reasoningDelta({reasoning_details:{summary:"итог"}}),"итог");
  // Обычный ответ и служебные поля не должны превращаться в размышления.
  assert.equal(reasoningDelta({content:"ответ"}),"");
  assert.equal(reasoningDelta({reasoning:{enabled:true}}),"");
  assert.equal(reasoningDelta(null),"");
});

test("keeps ordinary assistant messages unchanged in meaning",()=>{
  assert.deepEqual(
    toWireMessages([{role:"assistant",content:"done"}]),
    [{role:"assistant",content:"done"}]
  );
});

// Размышления шлюз отдаёт только по просьбе, поэтому проверяется весь путь: просьба уходит в запрос,
// поток мыслей превращается в чанки `reasoning`, а шлюз, который такого поля не знает, не ломает
// запуск — он получает повтор без просьбы. Шлюзы здесь разные адресами: отказ помнится по адресу.
const REASONING_DISABLED=/^(off|0|false|no)$/i.test((process.env.WEBNESTDEV_AI_REASONING??"").trim());

type CapturedRequest={url:string;body:Record<string,unknown>};

function sseBody(chunks:unknown[]){
  return chunks.map(chunk=>"data: "+JSON.stringify(chunk)+"\n\n").join("")+"data: [DONE]\n\n";
}

function streamResponse(chunks:unknown[]){
  return new Response(sseBody(chunks),{status:200,headers:{"content-type":"text/event-stream"}});
}

type FetchHandler=(request:CapturedRequest,index:number)=>Response;

function stubFetch(handler:FetchHandler){
  const captured:CapturedRequest[]=[];
  const original=globalThis.fetch;
  globalThis.fetch=(async(input:string|URL|Request,init?:RequestInit)=>{
    const request={url:String(input),body:JSON.parse(String(init?.body??"{}")) as Record<string,unknown>};
    captured.push(request);
    return handler(request,captured.length-1);
  }) as typeof globalThis.fetch;
  return {captured,restore:()=>{globalThis.fetch=original}};
}

async function collect(provider:OpenAICompatibleProvider,model:string){
  const chunks:ProviderChunk[]=[];
  for await(const chunk of provider.stream([{role:"user",content:"привет"}],model))chunks.push(chunk);
  return chunks;
}

test("размышление просят у модели и показывают в ответе",{skip:REASONING_DISABLED},async()=>{
  const stub=stubFetch(()=>streamResponse([
    {choices:[{delta:{reasoning_content:"сначала посмотрю файлы"}}]},
    {choices:[{delta:{content:"Готово"}}]}
  ]));
  try{
    const chunks=await collect(new OpenAICompatibleProvider("https://gateway-reasoning.example/v1"),"reasoning-model");
    assert.equal(stub.captured.length,1,"просьба о размышлении не должна стоить второго запроса");
    assert.equal(stub.captured[0].body.reasoning_effort,"medium");
    assert.deepEqual(chunks.filter(chunk=>chunk.type==="reasoning"),[{type:"reasoning",text:"сначала посмотрю файлы"}]);
    assert.deepEqual(chunks.filter(chunk=>chunk.type==="text"),[{type:"text",text:"Готово"}]);
  }finally{stub.restore()}
});

test("шлюз, не знающий reasoning_effort, получает повтор без просьбы и запоминается",{skip:REASONING_DISABLED},async()=>{
  const stub=stubFetch((_request,index)=>index===0
    ? new Response("unknown field reasoning_effort",{status:400})
    : streamResponse([{choices:[{delta:{content:"Ответ"}}]}]));
  try{
    const provider=new OpenAICompatibleProvider("https://gateway-strict.example/v1");
    const first=await collect(provider,"strict-model");
    assert.equal(stub.captured.length,2,"отказ должен стоить одного повтора");
    assert.equal(stub.captured[0].body.reasoning_effort,"medium");
    assert.ok(!("reasoning_effort" in stub.captured[1].body),"повтор идёт без поля, которого шлюз не знает");
    assert.deepEqual(first.filter(chunk=>chunk.type==="text"),[{type:"text",text:"Ответ"}]);
    // Второй шаг того же запуска уже не платит за отказ: адрес запомнен.
    await collect(provider,"strict-model");
    assert.equal(stub.captured.length,3);
    assert.ok(!("reasoning_effort" in stub.captured[2].body));
  }finally{stub.restore()}
});
