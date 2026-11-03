import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";

// The provider decides at import time whether requests go through the AI proxy, so the
// variable is cleared before the module is loaded.
delete process.env.AI_PROXY_URL;
const { OpenAICompatibleProvider, reasoningPassbackSupported, toWireMessages } = await import("./openai-compatible-provider.js");

function sseResponse(payloads: string[]) {
  const body = payloads.map(payload => "data: " + payload + "\n\n").join("");
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("reasoning deltas are streamed to the agent as their own chunks", async t => {
  const restore = sseResponse([
    '{"choices":[{"delta":{"reasoning_content":"Сначала "}}]}',
    '{"choices":[{"delta":{"reasoning_content":"посмотрю файлы."}}]}',
    '{"choices":[{"delta":{"content":"Смотрю проект."}}]}',
    "[DONE]",
  ]);
  t.after(restore);

  const provider = new OpenAICompatibleProvider("https://provider.test/v1", "key");
  const chunks = [];
  for await (const chunk of provider.stream([{ role: "user", content: "что тут?" }], "model", [], undefined)) chunks.push(chunk);

  assert.deepEqual(chunks.filter(chunk => chunk.type === "reasoning"), [
    { type: "reasoning", text: "Сначала " },
    { type: "reasoning", text: "посмотрю файлы." },
  ]);
  assert.equal(chunks.map(chunk => (chunk.type === "text" ? chunk.text : "")).join(""), "Смотрю проект.");
});

test("a gateway that sends reasoning under another key is understood too", async t => {
  const restore = sseResponse([
    '{"choices":[{"delta":{"reasoning":"Думаю "}}]}',
    '{"choices":[{"delta":{"reasoning_details":[{"text":"по-русски."}]}}]}',
    "[DONE]",
  ]);
  t.after(restore);

  const provider = new OpenAICompatibleProvider("https://provider.test/v1");
  const text = [];
  for await (const chunk of provider.stream([{ role: "user", content: "привет" }], "model", [], undefined)) {
    if (chunk.type === "reasoning") text.push(chunk.text);
  }
  assert.equal(text.join(""), "Думаю по-русски.");
});

test("DeepSeek thinking mode receives earlier reasoning_content back with the history", () => {
  const withThinking: ChatMessage[] = [
    { role: "assistant", content: "", reasoning: "Проверил сборку и тесты.", tool_calls: [{ id: "c1", name: "fs.read", arguments: { path: "src/App.tsx" } }] },
  ];
  const wire = toWireMessages(withThinking, { reasoningPassthrough: true });
  assert.equal(wire.length, 1);
  assert.equal(wire[0].role, "assistant");
  assert.equal(wire[0].role === "assistant" ? wire[0].reasoning_content : undefined, "Проверил сборку и тесты.");
  assert.equal(wire[0].role === "assistant" ? wire[0].tool_calls?.[0].function.name : undefined, "fs.read");
  // Even an assistant turn without a tool call must carry the field when tools are in the request.
  const withoutThinking = toWireMessages([{ role: "assistant", content: "Ответ." }], { reasoningPassthrough: true });
  assert.equal(withoutThinking[0].role === "assistant" ? withoutThinking[0].reasoning_content : undefined, "");
});

// Every other gateway gets exactly the old shape: an unknown assistant field is either rejected
// or billed as ordinary input, and the user still reads the thinking from the saved session.
test("non-DeepSeek gateways still do not receive stored reasoning", () => {
  const withThinking: ChatMessage[] = [
    { role: "assistant", content: "Готово.", reasoning: "Проверил сборку и тесты." },
  ];
  assert.deepEqual(toWireMessages(withThinking), [{ role: "assistant", content: "Готово." }]);
});

test("reasoning passback is selected from the model id, not from every provider", () => {
  assert.equal(reasoningPassbackSupported("https://api.polza.ai/api/v1", "deepseek/deepseek-v4.1-flash-1017"), true);
  assert.equal(reasoningPassbackSupported("https://api.deepseek.com/v1", "deepseek-flash"), true);
  assert.equal(reasoningPassbackSupported("https://api.openai.com/v1", "gpt-5.2-codex"), false);
});
