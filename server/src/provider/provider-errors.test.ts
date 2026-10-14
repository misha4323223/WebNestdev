import test from "node:test";
import assert from "node:assert/strict";
import { ProviderHttpError, classifyProviderError, describeProviderFailure, parseContextOverflow } from "./provider-errors.js";

/** The exact body the gateway returned in production, the reason this module exists. */
const CONTEXT_BODY = '{"error":{"message":"ContextWindowExceededError: OpenAIException - {\\"object\\":\\"error\\",\\"message\\":\\"The input (932489 tokens) is longer than the model\'s context length (524288 tokens).\\",\\"type\\":\\"BadRequestError\\"}","type":"invalid_request_error","code":"400"}}';

test("переполнение контекста отличается от прочих ошибок запроса", () => {
  assert.equal(classifyProviderError(400, CONTEXT_BODY), "CONTEXT_OVERFLOW");
  assert.equal(classifyProviderError(400, '{"error":"unknown field: temperature"}'), "BAD_REQUEST");
  assert.equal(classifyProviderError(401, "invalid api key"), "AUTH");
  assert.equal(classifyProviderError(403, "forbidden"), "AUTH");
  assert.equal(classifyProviderError(429, "rate limited"), "RATE_LIMIT");
  assert.equal(classifyProviderError(503, "upstream down"), "UNAVAILABLE");
});

test("числа переполнения читаются из тела ответа", () => {
  assert.deepEqual(parseContextOverflow(CONTEXT_BODY), { inputTokens: 932489, limitTokens: 524288 });
  assert.deepEqual(parseContextOverflow("no numbers here"), {});
});

test("сообщение об ошибке называет причину и оба числа, а не вываливает JSON", () => {
  const error = new ProviderHttpError(400, CONTEXT_BODY);
  assert.equal(error.code, "CONTEXT_OVERFLOW");
  assert.equal(error.inputTokens, 932489);
  assert.equal(error.limitTokens, 524288);
  assert.match(error.message, /932489/);
  assert.match(error.message, /524288/);
  assert.match(error.message, /новый диалог/);
  assert.ok(!error.message.includes('{"error"'), "пользователь не должен читать сырой JSON");
});

test("понятные подсказки для ключа, лимита частоты и недоступности", () => {
  assert.match(new ProviderHttpError(401, "bad key").message, /ключ/);
  assert.match(new ProviderHttpError(429, "slow down").message, /частоту/);
  assert.match(new ProviderHttpError(502, "bad gateway").message, /недоступен/);
  assert.match(new ProviderHttpError(400, "bad shape").message, /HTTP 400/);
});

test("сырой текст провайдера сохраняется для лога, но не растёт до мегабайта", () => {
  const error = new ProviderHttpError(500, "x".repeat(5000));
  assert.equal(error.detail.length, 500);
  assert.match(describeProviderFailure(error), /HTTP 500 \(UNAVAILABLE\)/);
});
