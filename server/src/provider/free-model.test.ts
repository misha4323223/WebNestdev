import assert from "node:assert/strict";
import test from "node:test";
import { createFreeModelRoute,describeFreeModelRoute,getFreeModelConfig } from "./free-model.js";

const NAMES=[
  "PLATFORM_AI_FREE_BASE_URL","PLATFORM_AI_FREE_MODEL","PLATFORM_AI_FREE_PROVIDER","PLATFORM_AI_FREE_KEY_1","PLATFORM_AI_FREE_KEY_2","PLATFORM_AI_FREE_KEY_3",
  "PLATFORM_AI_BASE_URL","PLATFORM_AI_MODEL","PLATFORM_AI_API_KEY","PLATFORM_AI_PROVIDER",
  "AI_BASE_URL","AI_MODEL","AI_API_KEY","AI_PROVIDER",
];
function clear(){for(const name of NAMES)delete process.env[name];}

test("без адреса, модели и ключей бесплатная цепочка не включается",()=>{
  clear();
  assert.equal(getFreeModelConfig(),null);

  process.env.PLATFORM_AI_FREE_BASE_URL="https://apihub.agnes-ai.com/v1";
  process.env.PLATFORM_AI_FREE_MODEL="agnes-2.5-flash";
  assert.equal(getFreeModelConfig(),null,"одного адреса и модели мало — нужен хотя бы один ключ");

  process.env.PLATFORM_AI_FREE_KEY_1="key-1";
  const config=getFreeModelConfig();
  assert.equal(config?.baseUrl,"https://apihub.agnes-ai.com/v1");
  assert.equal(config?.model,"agnes-2.5-flash");
  assert.deepEqual(config?.keys,["key-1"]);
  assert.equal(config?.fallback,null,"без PLATFORM_AI_* резерва нет");
  clear();
});

test("имя бесплатного провайдера задаётся окружением, по умолчанию Agnes AI",()=>{
  clear();
  process.env.PLATFORM_AI_FREE_BASE_URL="https://apihub.agnes-ai.com/v1";
  process.env.PLATFORM_AI_FREE_MODEL="agnes-2.5-flash";
  process.env.PLATFORM_AI_FREE_KEY_1="key-1";
  assert.equal(getFreeModelConfig()?.providerName,"Agnes AI");

  process.env.PLATFORM_AI_FREE_PROVIDER="  Cloudflare Workers AI  ";
  assert.equal(getFreeModelConfig()?.providerName,"Cloudflare Workers AI");
  assert.equal(createFreeModelRoute()?.providerName,"Cloudflare Workers AI");
  clear();
});

test("ключи читаются по порядку, пустые и повторы отбрасываются",()=>{
  clear();
  process.env.PLATFORM_AI_FREE_BASE_URL="https://apihub.agnes-ai.com/v1";
  process.env.PLATFORM_AI_FREE_MODEL="agnes-2.5-flash";
  process.env.PLATFORM_AI_FREE_KEY_1="  key-1  ";
  process.env.PLATFORM_AI_FREE_KEY_2="key-1";
  process.env.PLATFORM_AI_FREE_KEY_3="key-3";
  assert.deepEqual(getFreeModelConfig()?.keys,["key-1","key-3"]);
  clear();
});

test("резерв берётся из текущей модели платформы",()=>{
  clear();
  process.env.PLATFORM_AI_FREE_BASE_URL="https://apihub.agnes-ai.com/v1";
  process.env.PLATFORM_AI_FREE_MODEL="agnes-2.5-flash";
  process.env.PLATFORM_AI_FREE_KEY_1="key-1";
  process.env.PLATFORM_AI_BASE_URL="https://ai.api.cloud.yandex.net/v1";
  process.env.PLATFORM_AI_MODEL="gpt://folder/qwen/latest";
  process.env.PLATFORM_AI_API_KEY="yandex-key";
  process.env.PLATFORM_AI_PROVIDER="Yandex Cloud AI Studio";

  const config=getFreeModelConfig();
  assert.deepEqual(config?.fallback,{
    provider:"Yandex Cloud AI Studio",
    baseUrl:"https://ai.api.cloud.yandex.net/v1",
    model:"gpt://folder/qwen/latest",
    token:"yandex-key",
  });
  clear();
});

test("маршрут ставит бесплатные ключи первыми, резерв последним",()=>{
  const route=createFreeModelRoute({
    providerName:"Agnes AI",
    baseUrl:"https://apihub.agnes-ai.com/v1",
    model:"agnes-2.5-flash",
    keys:["key-1","key-2","key-3"],
    fallback:{provider:"Yandex Cloud AI Studio",baseUrl:"https://ai.api.cloud.yandex.net/v1",model:"gpt://folder/qwen/latest",token:"yandex-key"},
  });
  assert.ok(route);
  assert.equal(route.model,"agnes-2.5-flash");
  assert.equal(route.keyCount,3);
  assert.equal(route.fallback,true);

  const endpoints=(route.provider as unknown as {endpoints:Array<{role:string;id:string}>}).endpoints;
  assert.deepEqual(endpoints.map(endpoint=>endpoint.role),["primary","primary","primary","fallback"]);
  assert.deepEqual(endpoints.map(endpoint=>endpoint.id).slice(0,3),["free-0","free-1","free-2"]);
});
