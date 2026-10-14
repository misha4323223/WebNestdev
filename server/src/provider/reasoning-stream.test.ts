import test from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "../types.js";

// The provider decides at import time whether requests go through the AI proxy, so the
// variable is cleared before the module is loaded.
delete process.env.AI_PROXY_URL;
const { OpenAICompatibleProvider, toWireMessages } = await import("./openai-compatible-provider.js");

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

test("stored reasoning is never sent back to the provider", () => {
  const withThinking: ChatMessage[] = [
    { role: "assistant", content: "Готово.", reasoning: "Проверил сборку и тесты." },
  ];
  assert.deepEqual(toWireMessages(withThinking), [{ role: "assistant", content: "Готово." }]);
});
