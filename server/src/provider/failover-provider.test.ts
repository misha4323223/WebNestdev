import assert from "node:assert/strict";
import test from "node:test";
import { FailoverProvider,createFailoverState,type FailoverEndpoint } from "./failover-provider.js";
import { ProviderHttpError } from "./provider-errors.js";
import type { Provider,ProviderChunk } from "./provider-types.js";

function endpoint(id:string,role:"primary"|"fallback"="primary"):FailoverEndpoint{
  return {id,label:id,role,baseUrl:"https://"+id+".example/v1",model:"test-model",token:"key-"+id};
}

async function collect(provider:Provider,signal?:AbortSignal){
  const chunks:ProviderChunk[]=[];
  for await(const chunk of provider.stream([{role:"user",content:"привет"}],"ignored",undefined,signal))chunks.push(chunk);
  return chunks;
}

/** Провайдер с заранее заданным поведением; вызовы записываются по id ключа. */
function providerFor(calls:string[],behaviour:(endpoint:FailoverEndpoint)=>AsyncGenerator<ProviderChunk>):(endpoint:FailoverEndpoint)=>Provider{
  return endpoint=>({
    async *stream(){
      calls.push(endpoint.id);
      yield* behaviour(endpoint);
    },
  });
}

async function *answer(endpoint:FailoverEndpoint):AsyncGenerator<ProviderChunk>{
  yield {type:"text",text:"ответ "+endpoint.id};
  yield {type:"done"};
}

async function *failure(error:unknown):AsyncGenerator<ProviderChunk>{
  throw error;
}

test("первый ключ ответил — остальные не трогаются",async()=>{
  const calls:string[]=[];
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2"),endpoint("fallback","fallback")],{
    state:createFailoverState(),
    log:()=>{},
    create:providerFor(calls,answer),
  });
  const chunks=await collect(provider);
  assert.deepEqual(calls,["k1"]);
  assert.deepEqual(chunks,[{type:"text",text:"ответ k1"},{type:"done"}]);
});

test("успешный ответ называет ключ, который ответил",async()=>{
  const calls:string[]=[];
  const logs:string[]=[];
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2")],{
    state:createFailoverState(),
    now:()=>1_000,
    log:message=>logs.push(message),
    create:providerFor(calls,answer),
  });
  await collect(provider);
  assert.deepEqual(calls,["k1"]);
  assert.ok(logs.some(message=>/^\[provider\] k1 ответил за 0 мс$/.test(message)),JSON.stringify(logs));
});

test("429 переключает на следующий ключ и запоминает рабочий",async()=>{
  let now=1_000;
  const calls:string[]=[];
  const state=createFailoverState();
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2")],{
    state,
    now:()=>now,
    log:()=>{},
    create:providerFor(calls,endpoint=>endpoint.id==="k1"?failure(new ProviderHttpError(429,"slow down",2_000)):answer(endpoint)),
  });

  await collect(provider);
  assert.deepEqual(calls,["k1","k2"]);
  assert.equal(state.activeId,"k2");
  assert.ok((state.cooldowns.get("k1")??0)>now);

  // Следующий шаг начинает с рабочего ключа, а не с только что ограниченного.
  await collect(provider);
  assert.deepEqual(calls,["k1","k2","k2"]);
});

test("после паузы бесплатные ключи снова раньше резерва",async()=>{
  let now=1_000;
  const calls:string[]=[];
  const state=createFailoverState();
  let primaryFails=true;
  const provider=new FailoverProvider([endpoint("k1"),endpoint("fallback","fallback")],{
    state,
    now:()=>now,
    log:()=>{},
    create:providerFor(calls,endpoint=>{
      if(endpoint.id==="k1"&&primaryFails)return failure(new ProviderHttpError(401,"bad key"));
      return answer(endpoint);
    }),
  });

  await collect(provider);
  assert.deepEqual(calls,["k1","fallback"]);
  assert.equal(state.activeId,null,"резерв не становится основным ключом");

  // Пауза ключа кончилась, и он снова первый — даже если предыдущий шаг закончил резерв.
  now+=10*60_000+1;
  primaryFails=false;
  await collect(provider);
  assert.deepEqual(calls,["k1","fallback","k1"]);
  assert.equal(state.activeId,"k1");
});

test("отказ по контексту не сжигает соседние ключи",async()=>{
  const calls:string[]=[];
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2"),endpoint("fallback","fallback")],{
    state:createFailoverState(),
    log:()=>{},
    create:providerFor(calls,()=>failure(new ProviderHttpError(400,"This model's maximum context length is 50000 tokens"))),
  });
  await assert.rejects(collect(provider),error=>error instanceof ProviderHttpError&&error.code==="CONTEXT_OVERFLOW");
  assert.deepEqual(calls,["k1"]);
});

test("400 про неподдерживаемый запрос переключает на резерв",async()=>{
  const calls:string[]=[];
  const provider=new FailoverProvider([endpoint("k1"),endpoint("fallback","fallback")],{
    state:createFailoverState(),
    log:()=>{},
    create:providerFor(calls,endpoint=>endpoint.id==="k1"?failure(new ProviderHttpError(400,"tools are not supported")):answer(endpoint)),
  });
  const chunks=await collect(provider);
  assert.deepEqual(calls,["k1","fallback"]);
  assert.deepEqual(chunks,[{type:"text",text:"ответ fallback"},{type:"done"}]);
});

test("если часть ответа уже пришла, второй ключ не подключается",async()=>{
  const calls:string[]=[];
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2")],{
    state:createFailoverState(),
    log:()=>{},
    create:providerFor(calls,async function *(endpoint){
      if(endpoint.id==="k2")return yield* answer(endpoint);
      yield {type:"text",text:"начало"};
      throw new ProviderHttpError(503,"down");
    }),
  });

  const chunks:ProviderChunk[]=[];
  let failure:unknown=null;
  try{
    for await(const chunk of provider.stream([{role:"user",content:"привет"}],"ignored"))chunks.push(chunk);
  }catch(error){failure=error}
  assert.deepEqual(chunks,[{type:"text",text:"начало"}]);
  assert.ok(failure instanceof ProviderHttpError);
  assert.deepEqual(calls,["k1"]);
});

test("сетевой обрыв переключает на следующий ключ",async()=>{
  const calls:string[]=[];
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2")],{
    state:createFailoverState(),
    log:()=>{},
    create:providerFor(calls,endpoint=>endpoint.id==="k1"?failure(new TypeError("fetch failed")):answer(endpoint)),
  });
  await collect(provider);
  assert.deepEqual(calls,["k1","k2"]);
});

test("когда все ключи в паузе, шаг говорит сколько ждать и не долбит их",async()=>{
  let now=1_000;
  const calls:string[]=[];
  const state=createFailoverState();
  const provider=new FailoverProvider([endpoint("k1"),endpoint("k2")],{
    state,
    now:()=>now,
    log:()=>{},
    create:providerFor(calls,()=>failure(new ProviderHttpError(429,"slow down"))),
  });

  await assert.rejects(collect(provider),error=>error instanceof ProviderHttpError&&error.code==="RATE_LIMIT");
  assert.deepEqual(calls,["k1","k2"]);

  await assert.rejects(collect(provider),error=>error instanceof ProviderHttpError&&error.code==="RATE_LIMIT"&&Boolean(error.retryAfterMs));
  assert.deepEqual(calls,["k1","k2"],"остывающие ключи не должны получать новый запрос");
});
