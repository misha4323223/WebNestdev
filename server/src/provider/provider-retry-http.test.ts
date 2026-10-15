import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { withProviderRetry } from "./provider-retry.js";
import type { ChatMessage } from "../types.js";

/**
 * The real thing, not a mock provider: an actual HTTP server that answers the way a rate-limited
 * gateway does — 429 with `Retry-After`, then a normal SSE answer. This is the path the user hit:
 * the panel said «Провайдер ограничил частоту запросов (HTTP 429). Подождите минуту и повторите
 * запуск.» and the run was over. Now the same request goes out again and the step finishes.
 */
async function answerThenServe() {
  const requests: { path: string; retryAfter: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "", retryAfter: request.headers["retry-after"] as string | undefined });
    if (requests.length === 1) {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: { message: "rate limit exceeded, retry after 1 seconds" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"думаю"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"готов"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"о"}}]}\n\n');
    response.write('data: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
    response.write("data: [DONE]\n\n");
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { requests, base: "http://127.0.0.1:" + port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("настоящий 429 переживается: тот же запрос уходит повторно и получает ответ", async () => {
  const upstream = await answerThenServe();
  try {
    const provider = new OpenAICompatibleProvider(upstream.base);
    const waits: number[] = [];
    const text = await withProviderRetry(async () => {
      let out = "";
      for await (const chunk of provider.stream([{ role: "user", content: "привет" }] as ChatMessage[], "тест-модель")) {
        if (chunk.type === "text") out += chunk.text;
      }
      return out;
    }, {
      attempts: 3, baseDelayMs: 50, maxDelayMs: 5_000, budgetMs: 10_000,
      sleep: async ms => { waits.push(ms) },
    });

    assert.equal(text, "готово", "ответ получен после повтора");
    assert.equal(upstream.requests.length, 2, "запрос ушёл ровно дважды");
    assert.equal(upstream.requests[0]!.path, upstream.requests[1]!.path, "повтор идёт по тому же адресу");
    // Пауза — это то, что просил сам шлюз (Retry-After: 1), а не наш backoff в 50 мс.
    assert.deepEqual(waits, [1000]);
  } finally {
    await upstream.close();
  }
});

test("лимит, который держится, объясняется пользователю, а не сырым 429", async () => {
  const requests: number[] = [];
  const server = createServer((_request, response) => {
    requests.push(Date.now());
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "slow down" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const provider = new OpenAICompatibleProvider("http://127.0.0.1:" + port);
    await assert.rejects(
      withProviderRetry(async () => {
        for await (const _chunk of provider.stream([{ role: "user", content: "привет" }] as ChatMessage[], "тест-модель")) { /* пусто */ }
        return "";
      }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 5, budgetMs: 50, sleep: async () => {} }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /частоту/);
        assert.match(error.message, /Продолжить/);
        assert.ok(!error.message.includes("slow down"), "пользователь читает объяснение, а не тело ответа");
        return true;
      },
    );
    assert.equal(requests.length, 3, "попытки ровно по настройке");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
