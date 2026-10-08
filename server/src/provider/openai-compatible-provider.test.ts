import assert from "node:assert/strict";
import test from "node:test";
import { toWireMessages } from "./openai-compatible-provider.js";
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

test("keeps ordinary assistant messages unchanged in meaning",()=>{
  assert.deepEqual(
    toWireMessages([{role:"assistant",content:"done"}]),
    [{role:"assistant",content:"done"}]
  );
});
