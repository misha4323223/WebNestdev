import test from "node:test";
import assert from "node:assert/strict";
import { ProviderHttpError,parseRetryAfterHeader } from "./provider-errors.js";
import { ProviderRetryExhaustedError,describeProviderRetry,pluralRu,providerRetryDecision,providerRetryDelayMs,providerRetryPolicy,withProviderRetry } from "./provider-retry.js";

/** No test may wait for real: the pauses are recorded and resolved at once. */
function recordingSleep(waits:number[]){
  return async (ms:number)=>{waits.push(ms)};
}

const policy={attempts:3,baseDelayMs:1000,maxDelayMs:30000,budgetMs:60000};

test("лимит частоты и недоступность повторяются, отказ по запросу — нет",()=>{
  assert.equal(providerRetryDecision(new ProviderHttpError(429,"rate limited")).retryable,true);
  assert.equal(providerRetryDecision(new ProviderHttpError(503,"upstream down")).retryable,true);
  assert.equal(providerRetryDecision(new Error("fetch failed")).retryable,true);
  assert.equal(providerRetryDecision(new Error("socket hang up")).retryable,true);
  // Это не «попробуй ещё»: ключ, форма запроса и переполненный контекст требуют другого лечения.
  assert.equal(providerRetryDecision(new ProviderHttpError(401,"bad key")).retryable,false);
  assert.equal(providerRetryDecision(new ProviderHttpError(400,'{"error":"unknown field"}')).retryable,false);
  assert.equal(providerRetryDecision(new ProviderHttpError(400,'[{"code":"too_big","maximum":100,"path":["messages"]}]')).retryable,false);
  // Остановленный пользователем запуск не повторяется ни при каких условиях.
  const aborted=new Error("This operation was aborted");aborted.name="AbortError";
  assert.equal(providerRetryDecision(aborted).retryable,false);
});

test("подсказка шлюза о паузе читается из заголовка и из тела",()=>{
  assert.equal(parseRetryAfterHeader("30"),30000);
  assert.equal(parseRetryAfterHeader("0.5"),500);
  assert.equal(parseRetryAfterHeader(new Date(Date.now()+15000).toUTCString())!>=14000,true);
  assert.equal(parseRetryAfterHeader(""),undefined);
  assert.equal(parseRetryAfterHeader(null),undefined);
  assert.equal(parseRetryAfterHeader("not a date"),undefined);
  // Тело: и миллисекунды, и секунды, и фраза «retry after 20 seconds».
  assert.equal(new ProviderHttpError(429,'{"retry_after_ms":4500}').retryAfterMs,4500);
  assert.equal(new ProviderHttpError(429,'{"error":{"retry_after":"20"}}').retryAfterMs,20000);
  assert.equal(new ProviderHttpError(429,"Please retry after 45 seconds").retryAfterMs,45000);
  // Заголовок важнее тела.
  assert.equal(new ProviderHttpError(429,'{"retry_after":"20"}',1500).retryAfterMs,1500);
});

test("пауза растёт и никогда не короче той, что назвал провайдер",()=>{
  const noJitter=()=>0;
  assert.equal(providerRetryDelayMs(1,policy,undefined,noJitter),800);
  assert.equal(providerRetryDelayMs(2,policy,undefined,noJitter),1600);
  // Названная шлюзом пауза побеждает свой backoff, но свой потолок остаётся.
  assert.equal(providerRetryDelayMs(1,policy,20000,noJitter),20000);
  assert.equal(providerRetryDelayMs(1,policy,900000,noJitter),30000);
});

test("шаг переживает лимит частоты: ждёт и повторяет тот же запрос",async()=>{
  const waits:number[]=[];
  const announced:{attempt:number;attempts:number;waitMs:number;code?:string}[]=[];
  let attempts=0;
  const result=await withProviderRetry(async()=>{
    attempts++;
    if(attempts<=2)throw new ProviderHttpError(429,"rate limited");
    return "готово";
  },{...policy,sleep:recordingSleep(waits),onWait:info=>announced.push(info),random:()=>0});

  assert.equal(result,"готово");
  assert.equal(attempts,3);
  assert.deepEqual(waits,[800,1600],"пауза удваивается, а не повторяется сразу");
  assert.deepEqual(announced.map(item=>item.attempt),[2,3]);
  assert.equal(announced[0]!.code,"RATE_LIMIT");
});

test("подсказка провайдера заставляет ждать ровно столько, сколько он просил",async()=>{
  const waits:number[]=[];
  let attempts=0;
  await withProviderRetry(async()=>{
    attempts++;
    if(attempts===1)throw new ProviderHttpError(429,"slow down",12000);
    return "готово";
  },{...policy,sleep:recordingSleep(waits),random:()=>0});
  assert.deepEqual(waits,[12000]);
});

test("попытки кончились — понятная фраза вместо сырого 429",async()=>{
  const waits:number[]=[];
  await assert.rejects(
    withProviderRetry(async()=>{throw new ProviderHttpError(429,"rate limited")},{...policy,sleep:recordingSleep(waits),random:()=>0}),
    (error:unknown)=>{
      assert.ok(error instanceof ProviderRetryExhaustedError);
      assert.equal(error.code,"RATE_LIMIT");
      assert.match(error.message,/частоту/);
      assert.match(error.message,/подождал/);
      // «2 раза», а не «2 раз»: фразу читает пользователь.
      assert.match(error.message,/повторил запрос 2 раза/);
      assert.match(error.message,/Продолжить/);
      return true;
    },
  );
  assert.equal(waits.length,2,"повторов ровно на одну попытку меньше");
  assert.equal(waits.reduce((sum,value)=>sum+value,0),2400);
});

test("бюджет ожидания ограничивает терпение, даже если попытки остались",async()=>{
  const waits:number[]=[];
  await assert.rejects(
    withProviderRetry(async()=>{throw new ProviderHttpError(503,"upstream down")},{
      attempts:50,baseDelayMs:1000,maxDelayMs:30000,budgetMs:5000,sleep:recordingSleep(waits),random:()=>0,
    }),
    (error:unknown)=>error instanceof ProviderRetryExhaustedError&&error.code==="UNAVAILABLE",
  );
  // 800 + 1600 + 2600 (третья пауза обрезана остатком бюджета) — и ни секунды сверх него.
  assert.deepEqual(waits,[800,1600,2600]);
  assert.equal(waits.reduce((sum,value)=>sum+value,0),5000);
});

test("отказ по размеру контекста не тратит паузы: его лечит step-runner",async()=>{
  const waits:number[]=[];
  await assert.rejects(
    withProviderRetry(async()=>{throw new ProviderHttpError(400,'The input (932489 tokens) is longer than the context length (524288 tokens)')},{...policy,sleep:recordingSleep(waits)}),
    (error:unknown)=>error instanceof ProviderHttpError&&error.code==="CONTEXT_OVERFLOW",
  );
  assert.equal(waits.length,0);
});

test("шаг, уже начавший отвечать, не повторяется — иначе текст пришёл бы дважды",async()=>{
  const waits:number[]=[];
  const partial=new ProviderHttpError(503,"connection reset mid-stream");
  Object.assign(partial,{partialStreamed:true});
  await assert.rejects(
    withProviderRetry(async()=>{throw partial},{...policy,sleep:recordingSleep(waits)}),
    (error:unknown)=>error===partial,
  );
  assert.equal(waits.length,0);
});

test("остановленный запуск не ждёт и не повторяется",async()=>{
  const waits:number[]=[];
  const controller=new AbortController();
  const run=withProviderRetry(async()=>{controller.abort();throw new ProviderHttpError(429,"rate limited")},{
    ...policy,signal:controller.signal,sleep:recordingSleep(waits),
  });
  await assert.rejects(run,(error:unknown)=>error instanceof ProviderHttpError&&(error as ProviderHttpError).code==="RATE_LIMIT");
  assert.equal(waits.length,0);
});

test("счётное слово в отчёте о повторах согласовано с числом",()=>{
  assert.equal(pluralRu(1,"раз","раза","раз"),"раз");
  assert.equal(pluralRu(2,"раз","раза","раз"),"раза");
  assert.equal(pluralRu(4,"раз","раза","раз"),"раза");
  assert.equal(pluralRu(5,"раз","раза","раз"),"раз");
  assert.equal(pluralRu(11,"раз","раза","раз"),"раз");
  assert.equal(pluralRu(21,"раз","раза","раз"),"раз");
  assert.equal(pluralRu(22,"раз","раза","раз"),"раза");
});

test("пределы терпения настраиваются и печатаются при старте",()=>{
  const keys=["AGENT_PROVIDER_RETRIES","AGENT_PROVIDER_RETRY_BASE_MS"];
  const before=keys.map(key=>process.env[key]);
  try{
    process.env.AGENT_PROVIDER_RETRIES="7";
    process.env.AGENT_PROVIDER_RETRY_BASE_MS="500";
    const configured=providerRetryPolicy();
    assert.equal(configured.attempts,7);
    assert.equal(configured.baseDelayMs,500);
    assert.match(describeProviderRetry(),/7 попыток/);
  }finally{
    keys.forEach((key,index)=>{
      const value=before[index];
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    });
  }
  const defaults=providerRetryPolicy();
  assert.equal(defaults.attempts,5);
  assert.equal(defaults.budgetMs,300000);
});
