import test from "node:test";
import assert from "node:assert/strict";
import type { Provider,ProviderChunk } from "../provider.js";
import type { AgentEvent,ChatMessage } from "../types.js";
import { registerTool } from "../tool-registry.js";
import { SCOUT_TOOLS,SCOUT_WEB_DISABLED_MESSAGE,SCOUT_WEB_TOOLS,createScoutRunner,parseScoutResult } from "./scout.js";

/**
 * Настоящий `fs.grep` в этом тесте не нужен: проверяется цикл разведчика, а не песочница.
 * Имя обязано быть из белого списка, иначе вызов отклонится до реестра.
 */
let grepCalls=0;
registerTool({
  name: "fs.grep",
  description: "тестовый поиск",
  parameters: { type: "object" },
  execute: async () => {
    grepCalls++;
    return { matches: [{ file: "src/app.ts", line: 1, text: "hello" }] };
  },
});

let webSearchCalls=0;
registerTool({
  name: "web.search",
  description: "тестовый веб-поиск",
  parameters: { type: "object" },
  execute: async () => {
    webSearchCalls++;
    return { ok: true, query: "vue", results: [{ title: "Vue docs", url: "https://vuejs.org/guide/", snippet: "guide" }] };
  },
});
registerTool({
  name: "web.read",
  description: "тестовое чтение страницы",
  parameters: { type: "object" },
  execute: async () => ({ ok: true, url: "https://vuejs.org/guide/", title: "Vue", text: "guide", truncated: false }),
});

type ScriptedStep={text?:string;calls?:Array<{name:string;arguments?:Record<string,unknown>}>};

function scripted(steps:ScriptedStep[]){
  const requests:Array<{messages:ChatMessage[];tools:Array<{function?:{name?:string}}>}>= [];
  const provider:Provider={
    async *stream(messages,_model,tools):AsyncGenerator<ProviderChunk>{
      requests.push({messages,tools:(tools??[]) as Array<{function?:{name?:string}}>});
      const step=steps[Math.min(requests.length-1,steps.length-1)];
      if(step?.text)yield {type:"text",text:step.text};
      for(let index=0;index<(step?.calls?.length??0);index++){
        const call=step.calls![index]!;
        yield {type:"tool_call",call:{id:"call-"+requests.length+"-"+index,name:call.name,arguments:call.arguments??{}}};
      }
      yield {type:"usage",promptTokens:100,completionTokens:10};
    },
  };
  return {provider,requests};
}

function options(provider:Provider,webSearch=false){
  return {
    provider,
    model:"тест-модель",
    runId:"run-scout",
    request:{projectId:"p",userId:"u",messages:[] as ChatMessage[],...(webSearch?{webSearch:true}:{})},
    emit:()=>{},
  };
}

test("разведчик читает файлы и возвращает разобранный JSON, не засоряя переписку", async () => {
  grepCalls=0;
  const {provider,requests}=scripted([
    {calls:[{name:"fs.grep",arguments:{pattern:"hello"}}]},
    {text:'```json\n{"summary":"hello найден в src/app.ts","files":["src/app.ts"],"findings":["fs.grep: src/app.ts:1"]}\n```'},
  ]);
  const events:AgentEvent[]=[];
  const scout=createScoutRunner({
    ...options(provider),
    emit:event=>events.push(event),
  });
  const result=await scout({task:"где определён hello?"});

  assert.equal(result.ok,true);
  assert.equal(result.summary,"hello найден в src/app.ts");
  assert.deepEqual(result.files,["src/app.ts"]);
  assert.deepEqual(result.findings,["fs.grep: src/app.ts:1"]);
  assert.equal(grepCalls,1,"read-only инструмент действительно вызван");
  assert.equal(requests.length,2);
  assert.ok(requests[0]!.tools.some(tool=>tool.function?.name==="fs.grep"));
  assert.ok(
    !events.some(event=>event.type==="message.delta"||event.type==="reasoning.delta"),
    "текст и размышления разведчика не должны появляться как ответ основного агента",
  );
});

test("изменяющий инструмент отклоняется до реестра, и разведчик может исправиться", async () => {
  const {provider,requests}=scripted([
    {calls:[{name:"fs.write",arguments:{path:"src/app.ts",content:"x"}}]},
    {text:JSON.stringify({summary:"Только чтение",files:[],findings:[]})},
  ]);
  const scout=createScoutRunner(options(provider));
  const result=await scout({task:"попробуй изменить файл"});

  assert.equal(result.ok,true);
  assert.equal(result.summary,"Только чтение");
  const toolResult=requests[1]!.messages.at(-1);
  assert.equal(toolResult?.role,"tool");
  assert.match(toolResult?.role==="tool"?toolResult.content:"",/недоступен.*разведчик/i);
  assert.ok(!requests[0]!.tools.some(tool=>tool.function?.name==="fs.write"),"схемы изменяющих инструментов не отправляются");
});

test("лимит шагов не теряет итог: последний запрос идёт без инструментов", async () => {
  const {provider,requests}=scripted([
    {calls:[{name:"fs.grep",arguments:{pattern:"a"}}]},
    {calls:[{name:"fs.grep",arguments:{pattern:"b"}}]},
    {text:JSON.stringify({summary:"Итог по прочитанному",files:["src/app.ts"],findings:["деталь"]})},
  ]);
  const scout=createScoutRunner({...options(provider),maxSteps:2});
  const result=await scout({task:"исследуй проект"});

  assert.equal(requests.length,3,"два шага разведки и один финальный итог");
  assert.equal(requests[2]!.tools.length,0,"финальный итог запрашивается без инструментов");
  assert.equal(result.ok,true);
  assert.equal(result.summary,"Итог по прочитанному");
  assert.ok(result.findings.some(item=>/лимит/i.test(item)),"ограничение видно основному агенту");
});

test("разведчик не может вызвать другого разведчика", async () => {
  const {provider,requests}=scripted([
    {calls:[{name:"agent.scout",arguments:{task:"вложенная разведка"}}]},
    {text:JSON.stringify({summary:"Рекурсии нет",files:[],findings:[]})},
  ]);
  const scout=createScoutRunner(options(provider));
  await scout({task:"проверь вложенность"});

  assert.ok(!(SCOUT_TOOLS as readonly string[]).includes("agent.scout"));
  assert.ok(requests.every(request=>!request.tools.some(tool=>tool.function?.name==="agent.scout")),"схема agent.scout не отправляется");
  const toolResult=requests[1]!.messages.at(-1);
  assert.match(toolResult?.role==="tool"?toolResult.content:"",/недоступен.*разведчик/i);
});

test("веб-профиль ищет в интернете и возвращает только реальные источники", async () => {
  webSearchCalls=0;
  const {provider,requests}=scripted([
    {calls:[
      {name:"web.search",arguments:{query:"vue 3 release notes"}},
      {name:"web.read",arguments:{url:"https://vuejs.org/guide/"}},
    ]},
    {text:'```json\n{"summary":"Vue 3.5 — актуальная версия","files":[],"findings":["Vue docs: 3.5"],"sources":["https://vuejs.org/guide/","https://not-read.example/vue","javascript:alert(1)","https://vuejs.org/guide/"]}\n```'},
  ]);
  const scout=createScoutRunner(options(provider,true));
  const result=await scout({task:"какая версия Vue актуальна?",kind:"web"});

  assert.equal(result.ok,true);
  assert.equal(result.summary,"Vue 3.5 — актуальная версия");
  assert.deepEqual(result.sources,["https://vuejs.org/guide/"],"только реально прочитанный источник, без дублей и мусора");
  assert.equal(webSearchCalls,1,"веб-инструмент действительно вызван");
  assert.ok(requests[0]!.tools.some(tool=>tool.function?.name==="web.search"));
  assert.ok(!requests[0]!.tools.some(tool=>tool.function?.name==="fs.read"),"веб-профиль не получает инструменты проекта");
});

test("веб-профиль не стартует, пока пользователь не включил поиск", async () => {
  const {provider,requests}=scripted([{text:"не должно выполниться"}]);
  const scout=createScoutRunner(options(provider,false));
  await assert.rejects(
    scout({task:"найди документацию",kind:"web"}),
    (error:unknown)=>error instanceof Error&&error.message===SCOUT_WEB_DISABLED_MESSAGE,
  );
  assert.equal(requests.length,0,"провайдер не вызывается без разрешения пользователя");
});

test("кодовый профиль не получает веб-инструменты, даже когда поиск включён", async () => {
  const {provider,requests}=scripted([{text:JSON.stringify({summary:"код",files:[],findings:[]})}]);
  const scout=createScoutRunner(options(provider,true));
  await scout({task:"найди файл",kind:"code"});

  assert.deepEqual([...SCOUT_WEB_TOOLS],["web.search","web.read"]);
  assert.ok(!requests[0]!.tools.some(tool=>tool.function?.name==="web.search"),"профиль code остаётся только по проекту");
  assert.ok(requests[0]!.tools.some(tool=>tool.function?.name==="fs.grep"));
});

test("неизвестный профиль разведки отклоняется до запроса", async () => {
  const {provider,requests}=scripted([{text:"не должно выполниться"}]);
  const scout=createScoutRunner(options(provider));
  await assert.rejects(
    scout({task:"что-то",kind:"shell" as never}),
    /неизвестный профиль разведки/i,
  );
  assert.equal(requests.length,0);
});

test("ответ разведчика не превышает лимит вывода инструмента и остаётся JSON", () => {
  const parsed=parseScoutResult(JSON.stringify({
    summary:"с".repeat(5000),
    files:Array.from({length:40},(_,index)=>"src/very/deep/path/file-"+index+".ts"),
    findings:Array.from({length:40},(_,index)=>"факт "+index+" "+"ф".repeat(500)),
    sources:Array.from({length:40},(_,index)=>"https://example.com/page/"+index+"/"+"x".repeat(600)),
  }));
  const serialized=JSON.stringify(parsed);
  assert.ok(serialized.length<=12000,"JSON помещается в agent.scout: "+serialized.length);
  const reparsed=JSON.parse(serialized) as {summary?:unknown;files?:unknown[];findings?:unknown[];sources?:unknown[]};
  assert.equal(typeof reparsed.summary,"string");
  assert.ok(Array.isArray(reparsed.files)&&Array.isArray(reparsed.findings));
  assert.ok((reparsed.sources?.length??0)<=16);
});

test("ответ разбирается и из markdown-обёртки, и из обычного текста", () => {
  const parsed=parseScoutResult('```json\n{"summary":"карта","files":["a.ts","a.ts",2],"findings":["x"],"sources":["https://example.com/a","https://example.com/a","ftp://example.com/b"]}\n```');
  assert.equal(parsed.ok,true);
  assert.equal(parsed.summary,"карта");
  assert.deepEqual(parsed.files,["a.ts"],"пути не повторяются, не-строки отброшены");
  assert.deepEqual(parsed.sources,["https://example.com/a"],"в источники попадают только http(s) и без повторов");

  const plain=parseScoutResult("Просто текстовый ответ без JSON");
  assert.equal(plain.ok,true);
  assert.equal(plain.summary,"Просто текстовый ответ без JSON");

  const empty=parseScoutResult("   ");
  assert.equal(empty.ok,false);
});
