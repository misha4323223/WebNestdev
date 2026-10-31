import assert from "node:assert/strict";
import test from "node:test";
import { DsmlTextFilter,parseDsmlToolCalls } from "./dsml-tool-calls.js";

// The literal control token is split into pieces so this test file never contains a raw
// special token. BAR is the fullwidth vertical bar used around "DSML" by DeepSeek V4.
const BAR="\uFF5C";
const open=(name:string)=>`<${BAR}DSML${BAR}${name}>`;
const close=(name:string)=>`</${BAR}DSML${BAR}${name}>`;
const wrapper=(body:string)=>open("tool_calls")+body+close("tool_calls");
const invoke=(name:string,body="")=>`<${BAR}DSML${BAR}invoke name="${name}">${body}</${BAR}DSML${BAR}invoke>`;
const parameter=(name:string,value:string,string=true)=>`<${BAR}DSML${BAR}parameter name="${name}" string="${string}">${value}</${BAR}DSML${BAR}parameter>`;
const tools=(...names:string[])=>names.map(name=>({type:"function",function:{name}}));

test("DSML: строковый и JSON-параметр восстанавливаются в tool call",()=>{
  const raw=wrapper(invoke("fs.write",
    parameter("path","src/a.ts")+
    parameter("options",'{"overwrite":true}',false)+
    parameter("content","if (a < b && c > d)")+
  ""));
  const result=parseDsmlToolCalls(raw,new Set(["fs.write"]));
  assert.equal(result.text,"");
  assert.equal(result.calls.length,1);
  assert.equal(result.calls[0].name,"fs.write");
  assert.deepEqual(result.calls[0].arguments,{
    path:"src/a.ts",
    options:{overwrite:true},
    content:"if (a < b && c > d)"
  });
});

test("DSML: несколько вызовов в одном блоке",()=>{
  const raw=wrapper(
    invoke("fs.read",parameter("path","README.md"))+
    invoke("fs.write",parameter("path","TASKS.md")+parameter("content","# Задачи"))
  );
  const result=parseDsmlToolCalls(raw,new Set(["fs.read","fs.write"]));
  assert.deepEqual(result.calls.map(call=>call.name),["fs.read","fs.write"]);
  assert.deepEqual(result.calls[1].arguments,{path:"TASKS.md",content:"# Задачи"});
});

test("DSML: битый или отсутствующий открывающий конверт всё равно восстанавливается",()=>{
  const misspelled=open("toolcalls")+invoke("fs.write",parameter("path","a.ts"));
  assert.equal(parseDsmlToolCalls(misspelled,new Set(["fs.write"])).calls.length,1);

  const orphan=invoke("fs.read",parameter("path","b.ts"));
  const result=parseDsmlToolCalls(orphan,new Set(["fs.read"]));
  assert.equal(result.calls.length,1);
  assert.deepEqual(result.calls[0].arguments,{path:"b.ts"});
});

test("DSML: инструмент, которого нет в запросе, не становится вызовом",()=>{
  const raw=wrapper(invoke("terminal.exec",parameter("command","rm -rf /")));
  const result=parseDsmlToolCalls(raw,new Set(["fs.write"]));
  assert.equal(result.calls.length,0);
  assert.ok(!result.text.includes("DSML"),"служебные теги не должны попадать в текст");
});

test("DSML: без объявленных инструментов разметка не трогается",()=>{
  const raw=wrapper(invoke("fs.write",parameter("path","a.ts")));
  const filter=new DsmlTextFilter(undefined);
  assert.deepEqual(filter.push("Пример "+raw),{text:"Пример "+raw,calls:[]});
  assert.deepEqual(filter.flush(),{text:"",calls:[]});
});

test("DSML: поток разрезается на любых границах, текст вокруг сохраняется",()=>{
  const raw="До "+wrapper(invoke("fs.write",parameter("path","a.ts")))+" После";
  const filter=new DsmlTextFilter(tools("fs.write"));
  let text="";
  const calls=[];
  for(let index=0;index<raw.length;index+=3){
    const chunk=filter.push(raw.slice(index,index+3));
    text+=chunk.text;
    calls.push(...chunk.calls);
  }
  const tail=filter.flush();
  text+=tail.text;
  calls.push(...tail.calls);
  assert.equal(text,"До  После");
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,"fs.write");
});

test("DSML: осиротевший закрывающий хвост не попадает в текст",()=>{
  const filter=new DsmlTextFilter(tools("fs.write"));
  const result=filter.push("Готово"+close("parameter")+close("invoke")+close("tool_calls"));
  assert.equal(result.text.replace(/\s+/g," ").trim(),"Готово");
  assert.equal(filter.flush().text,"");
});
