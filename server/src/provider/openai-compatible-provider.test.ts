import assert from "node:assert/strict";
import test from "node:test";
import { reasoningDelta, toWireMessages } from "./openai-compatible-provider.js";
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
