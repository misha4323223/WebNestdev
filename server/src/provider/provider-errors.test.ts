import test from "node:test";
import assert from "node:assert/strict";
import { ProviderHttpError, classifyProviderError, describeProviderFailure, parseContextOverflow, parseMaxMessages } from "./provider-errors.js";

/** The exact body the gateway returned in production, the reason this module exists. */
const CONTEXT_BODY = '{"error":{"message":"ContextWindowExceededError: OpenAIException - {\\"object\\":\\"error\\",\\"message\\":\\"The input (932489 tokens) is longer than the model\'s context length (524288 tokens).\\",\\"type\\":\\"BadRequestError\\"}","type":"invalid_request_error","code":"400"}}';
/**
 * The other production body, also the reason this module exists: the gateway validates the request
 * before calling the model and refuses a long `messages` array. A hundred short messages are small
 * and still refused, so this is not a context-size problem, and the fix is not the same.
 */
const TOO_MANY_MESSAGES_BODY = '[{"origin":"array","code":"too_big","maximum":100,"inclusive":true,"path":["messages"],"message":"Too big: expected array to have <=100 items"}]';

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

test("отказ по числу сообщений отличается от переполнения контекста", () => {
  assert.equal(classifyProviderError(400, TOO_MANY_MESSAGES_BODY), "TOO_MANY_MESSAGES");
  assert.equal(classifyProviderError(400, '{"error":"at most 50 items allowed"}'), "TOO_MANY_MESSAGES");
  assert.equal(classifyProviderError(400, "too many messages in the request"), "TOO_MANY_MESSAGES");
  // `too_big` само по себе ни о чём не говорит: так валидатор ругается на любое поле.
  assert.equal(classifyProviderError(400, '{"origin":"string","code":"too_big","maximum":100,"path":["model"]}'), "BAD_REQUEST");
  assert.equal(classifyProviderError(400, CONTEXT_BODY), "CONTEXT_OVERFLOW");
});

test("предел числа сообщений читается из тела ответа", () => {
  assert.equal(parseMaxMessages(TOO_MANY_MESSAGES_BODY), 100);
  assert.equal(parseMaxMessages("at most 50 items are allowed"), 50);
  assert.equal(parseMaxMessages("no numbers here"), undefined);
});

test("отказ по числу сообщений объясняется фразой с пределом, а не JSON от валидатора", () => {
  const error = new ProviderHttpError(400, TOO_MANY_MESSAGES_BODY);
  assert.equal(error.code, "TOO_MANY_MESSAGES");
  assert.equal(error.limitMessages, 100);
  assert.match(error.message, /100/);
  assert.match(error.message, /новый диалог/);
  assert.ok(!error.message.includes("too_big"), "служебный код не должен доходить до пользователя");
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
