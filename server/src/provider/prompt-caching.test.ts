import test from "node:test";
import assert from "node:assert/strict";
import {
  cacheHitRate,
  cacheUsageFromUsage,
  isPolzaGateway,
  promptCacheKey,
  promptCachePolicy,
  promptCacheRequestFields,
  withPromptCacheControl,
} from "./prompt-caching.js";

test("DeepSeek кэшируется автоматически, а Polza дополнительно закрепляет серию за провайдером", () => {
  assert.deepEqual(
    promptCachePolicy("https://polza.ai/api/v1", "deepseek/deepseek-v4.1-flash"),
    { mode: "automatic", family: "deepseek", routeByKey: true },
  );
  assert.deepEqual(
    promptCachePolicy("https://api.deepseek.com/v1", "deepseek-flash"),
    { mode: "automatic", family: "deepseek", routeByKey: false },
  );
  assert.equal(isPolzaGateway("https://api.polza.ai/v1"), true);
  assert.equal(isPolzaGateway("https://polza.ai.evil.example/v1"), false);
});

test("Claude получает явные точки кэша только на известных шлюзах", () => {
  assert.deepEqual(
    promptCachePolicy("https://polza.ai/api/v1", "anthropic/claude-sonnet-4.6"),
    { mode: "explicit", family: "anthropic", routeByKey: true },
  );
  assert.deepEqual(
    promptCachePolicy("https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4.6"),
    { mode: "explicit", family: "anthropic", routeByKey: false },
  );
  // Неизвестный прокси может не принять content-части: там кэш остаётся автоматическим
  // (или никаким), но запрос не ломается.
  assert.equal(promptCachePolicy("https://gateway.example/v1", "claude-sonnet").mode, "automatic");
  assert.deepEqual(
    promptCachePolicy("https://polza.ai/api/v1", "custom-model"),
    { mode: "none", family: "unknown", routeByKey: true },
  );
});

test("ключ серии стабилен в разговоре и не раскрывает идентификаторы", () => {
  const scope = { projectId: "project-secret", conversationId: "conversation-secret", runId: "run-1" };
  const first = promptCacheKey(scope, "deepseek/deepseek-v4.1-flash");
  assert.match(first, /^nestdev-[a-f0-9]{40}$/);
  assert.ok(!first.includes("project-secret"));
  assert.ok(!first.includes("conversation-secret"));
  assert.equal(first, promptCacheKey(scope, "deepseek/deepseek-v4.1-flash"));
  assert.notEqual(first, promptCacheKey({ ...scope, conversationId: "conversation-2" }, "deepseek/deepseek-v4.1-flash"));
  assert.notEqual(first, promptCacheKey(scope, "deepseek/deepseek-v4"));
});

test("поле маршрутизации отправляется только туда, где оно документировано", () => {
  const polza = promptCachePolicy("https://polza.ai/api/v1", "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(promptCacheRequestFields(polza, "nestdev-abc"), { prompt_cache_key: "nestdev-abc" });
  const direct = promptCachePolicy("https://api.deepseek.com/v1", "deepseek-flash");
  assert.deepEqual(promptCacheRequestFields(direct, "nestdev-abc"), {});
  // Незнакомой модели на Polza ключ серии тоже безопасен: поле документировано для всего
  // Chat Completions, а разметку контента мы ей не добавляем.
  assert.deepEqual(
    promptCacheRequestFields(promptCachePolicy("https://polza.ai/api/v1", "custom-model"), "nestdev-abc"),
    { prompt_cache_key: "nestdev-abc" },
  );
  assert.deepEqual(promptCacheRequestFields(polza, undefined), {});
});

test("счётчики кэша читаются из Polza, DeepSeek и нативного Anthropic", () => {
  assert.deepEqual(
    cacheUsageFromUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 } }),
    { cachedPromptTokens: 800, cacheWritePromptTokens: 100 },
  );
  assert.deepEqual(
    cacheUsageFromUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 600, cache_write_tokens: 120 }),
    { cachedPromptTokens: 600, cacheWritePromptTokens: 120 },
  );
  assert.deepEqual(
    cacheUsageFromUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }),
    { cachedPromptTokens: 900, cacheWritePromptTokens: 50 },
  );
  // Провайдер не может вернуть больше кэша, чем весь вход: мусорное число не должно
  // превращаться в отрицательный или превышающий 100 % показатель.
  assert.deepEqual(
    cacheUsageFromUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 5000 } }),
    { cachedPromptTokens: 1000, cacheWritePromptTokens: 0 },
  );
  assert.equal(cacheHitRate(1000, 800), 0.8);
  assert.equal(cacheHitRate(0, 800), 0);
  assert.equal(cacheHitRate(1000, 5000), 1);
});

test("явные точки ставятся на первый и последний системный блок и не трогают историю", () => {
  const messages = [
    { role: "system", content: "инструкции" },
    { role: "system", content: "контекст проекта" },
    { role: "user", content: "задача" },
    { role: "assistant", content: "ответ" },
  ];
  const marked = withPromptCacheControl(messages);
  assert.deepEqual(marked[0].content, [
    { type: "text", text: "инструкции", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(marked[1].content, [
    { type: "text", text: "контекст проекта", cache_control: { type: "ephemeral" } },
  ]);
  assert.deepEqual(marked.slice(2), messages.slice(2));
  // Исходный массив не мутируется: он ещё нужен рантайму и обрезке контекста.
  assert.equal(messages[0].content, "инструкции");
});

test("одно системное сообщение получает ровно одну точку", () => {
  const marked = withPromptCacheControl([{ role: "system", content: "только промпт" }]);
  const parts = marked[0].content as unknown as Array<{ cache_control?: unknown }>;
  assert.equal(parts.filter(part => part.cache_control).length, 1);
});
