import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderChunk } from "../provider.js";
import { ProviderHttpError } from "../provider/provider-errors.js";
import type { AgentEvent,ChatMessage } from "../types.js";
import type { AgentContext } from "./types.js";
import { ProviderRetryExhaustedError } from "../provider/provider-retry.js";
import { ContextBudgetError } from "./context-budget.js";
import { runBudgetedStep, toolDefinitionChars, type StepBudget } from "./step-runner.js";

/** The production body: input 932489 tokens against a 524288-token model. */
const CONTEXT_BODY = '{"error":{"message":"ContextWindowExceededError: The input (932489 tokens) is longer than the model\'s context length (524288 tokens).","type":"BadRequestError","code":"400"}}';
/**
 * The other production body: the gateway validates the request and refuses a long `messages` array,
 * whatever its size — a hundred short messages are small and still refused.
 */
const TOO_MANY_MESSAGES_BODY = '[{"origin":"array","code":"too_big","maximum":100,"inclusive":true,"path":["messages"],"message":"Too big: expected array to have <=100 items"}]';

/** A history of turns, not of tool output: the count is what such a gateway refuses. */
function manyTurns(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({ role: "user" as const, content: "шаг " + index }));
}

/** A provider that records how many messages it was asked to handle. */
function countingProvider(seen: number[], refusals = 0, body = TOO_MANY_MESSAGES_BODY): Provider {
  return {
    async *stream(messages: ChatMessage[]): AsyncGenerator<ProviderChunk> {
      seen.push(messages.length);
      if (seen.length <= refusals) throw new ProviderHttpError(400, body);
      yield { type: "text", text: "готово" };
      yield { type: "usage", promptTokens: 100, completionTokens: 10 };
    },
  };
}

function context(): AgentContext {
  return { runId: "проба", request: { projectId: "p", userId: "u", messages: [] }, emit: () => {} };
}

/** Long history of tool results, the shape a run collects before it runs out of context. */
function longHistory(): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "промпт" },
    { role: "user", content: "переделай лендинг" },
  ];
  for (let index = 0; index < 8; index++) {
    messages.push({ role: "assistant", content: "шаг " + index, tool_calls: [{ id: "c" + index, name: "terminal.exec", arguments: { command: "npm run build" } }] });
    messages.push({ role: "tool", content: "л".repeat(20000), tool_call_id: "c" + index });
  }
  return messages;
}

/** A provider that refuses `refusals` times with the context error and then answers. */
function refusingProvider(seen: number[], refusals = 1, usage = { promptTokens: 1000, completionTokens: 10 }): Provider {
  return {
    async *stream(messages: ChatMessage[]): AsyncGenerator<ProviderChunk> {
      seen.push(messages.reduce((sum, message) => sum + message.content.length, 0));
      if (seen.length <= refusals) throw new ProviderHttpError(400, CONTEXT_BODY);
      yield { type: "text", text: "готово" };
      yield { type: "usage", ...usage };
    },
  };
}

test("отказ по размеру контекста лечится сокращением и повтором, а не падением запуска", async () => {
  const seen: number[] = [];
  const prepared: number[] = [];
  const budget: StepBudget = { budgetTokens: 20000, charsPerToken: 3.6, maxMessages: 80 };
  const step = await runBudgetedStep(refusingProvider(seen), longHistory(), "agnes-3.0-flash", context(), budget, {
    onPrepared: value => prepared.push(value.tokens),
  });
  assert.equal(step.result.text, "готово");
  assert.equal(seen.length, 2, "провайдер получает вторую попытку");
  assert.ok(seen[1] < seen[0], "во второй попытке контекст меньше: " + seen[0] + " → " + seen[1]);
  assert.ok(step.budget.budgetTokens < budget.budgetTokens, "бюджет уменьшен: " + step.budget.budgetTokens);
  assert.equal(prepared.length, 2, "панель получает размер контекста и после сокращения");
  assert.ok(prepared[1] < prepared[0]);
});

test("повторный отказ становится понятной ошибкой с числами, а не сырым JSON", async () => {
  const seen: number[] = [];
  await assert.rejects(
    runBudgetedStep(refusingProvider(seen, 2), longHistory(), "agnes-3.0-flash", context(), { budgetTokens: 20000, charsPerToken: 3.6, maxMessages: 80 }),
    (error: unknown) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.match(error.message, /524288|20000/);
      assert.match(error.message, /новый диалог/);
      return true;
    },
  );
  assert.equal(seen.length, 2, "попыток ровно две");
});

test("отчёт провайдера калибрует оценку, а бюджет остаётся потолком", async () => {
  const seen: number[] = [];
  const step = await runBudgetedStep(refusingProvider(seen, 0, { promptTokens: 50000, completionTokens: 10 }), longHistory(), "модель", context(), { budgetTokens: 10000, charsPerToken: 3.6, maxMessages: 80 });
  assert.ok(step.budget.charsPerToken !== 3.6, "оценка символов на токен откалибрована: " + step.budget.charsPerToken);
  // Провайдер прислал больше, чем бюджет: потолок не поднимается, а следующий отбор отправит меньше.
  assert.ok(step.budget.budgetTokens <= 10000, "бюджет не вырос: " + step.budget.budgetTokens);
});

/**
 * Провайдер с лимитом частоты: первые `refusals` запросов отвечают 429, а не модель.
 * Раньше такой отказ был концом запуска и пользователь читал «подождите минуту и повторите запуск».
 */
function rateLimitedProvider(seen: number[], refusals = 1): Provider {
  return {
    async *stream(): AsyncGenerator<ProviderChunk> {
      seen.push(Date.now());
      if (seen.length <= refusals) throw new ProviderHttpError(429, "rate limited");
      yield { type: "text", text: "готово" };
      yield { type: "usage", promptTokens: 100, completionTokens: 10 };
    },
  };
}

test("лимит частоты не обрывает запуск: шаг ждёт и повторяется сам", async () => {
  const before = process.env.AGENT_PROVIDER_RETRY_BASE_MS;
  // Пауза проверяется отдельно (provider-retry.test.ts), здесь важно, что повтор вообще есть.
  process.env.AGENT_PROVIDER_RETRY_BASE_MS = "1";
  try {
    const seen: number[] = [];
    const events: AgentEvent[] = [];
    const step = await runBudgetedStep(rateLimitedProvider(seen), longHistory(), "agnes-3.0-flash", {
      ...context(),
      emit: event => events.push(event),
    }, { budgetTokens: 20000, charsPerToken: 3.6, maxMessages: 80 });
    assert.equal(step.result.text, "готово");
    assert.equal(seen.length, 2, "провайдер получает повторный запрос");
    const retry = events.find((event): event is Extract<AgentEvent, { type: "run.retrying" }> => event.type === "run.retrying");
    assert.ok(retry, "панель узнаёт, что шаг ждёт лимит, а не падает");
    assert.equal(retry.code, "RATE_LIMIT");
    assert.equal(retry.attempt, 2);
    assert.ok(retry.waitSeconds >= 1, "в панель уходит целое число секунд: " + retry.waitSeconds);
  } finally {
    if (before === undefined) delete process.env.AGENT_PROVIDER_RETRY_BASE_MS;
    else process.env.AGENT_PROVIDER_RETRY_BASE_MS = before;
  }
});

test("лимит, который держится дольше бюджета, объясняется словами и оставляет шанс продолжить", async () => {
  const before = { base: process.env.AGENT_PROVIDER_RETRY_BASE_MS, budget: process.env.AGENT_PROVIDER_RETRY_BUDGET_MS };
  process.env.AGENT_PROVIDER_RETRY_BASE_MS = "1";
  process.env.AGENT_PROVIDER_RETRY_BUDGET_MS = "3";
  try {
    const seen: number[] = [];
    await assert.rejects(
      runBudgetedStep(rateLimitedProvider(seen, 99), longHistory(), "модель", context(), { budgetTokens: 20000, charsPerToken: 3.6, maxMessages: 80 }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderRetryExhaustedError);
        assert.equal(error.code, "RATE_LIMIT");
        assert.match(error.message, /частоту/);
        assert.match(error.message, /Продолжить/);
        return true;
      },
    );
    assert.ok(seen.length > 1, "повторы были: " + seen.length);
  } finally {
    if (before.base === undefined) delete process.env.AGENT_PROVIDER_RETRY_BASE_MS;
    else process.env.AGENT_PROVIDER_RETRY_BASE_MS = before.base;
    if (before.budget === undefined) delete process.env.AGENT_PROVIDER_RETRY_BUDGET_MS;
    else process.env.AGENT_PROVIDER_RETRY_BUDGET_MS = before.budget;
  }
});

test("другие ошибки провайдера не повторяются", async () => {
  let attempts = 0;
  const provider: Provider = {
    async *stream(): AsyncGenerator<ProviderChunk> {
      attempts++;
      throw new ProviderHttpError(401, "invalid api key");
    },
  };
  await assert.rejects(
    runBudgetedStep(provider, longHistory(), "модель", context(), { budgetTokens: 20000, charsPerToken: 3.6, maxMessages: 80 }),
    (error: unknown) => error instanceof ProviderHttpError && error.code === "AUTH",
  );
  assert.equal(attempts, 1);
});

test("длинная история подрезается до отправки, а не после отказа", async () => {
  const seen: number[] = [];
  const overhead = toolDefinitionChars();
  await runBudgetedStep(refusingProvider(seen, 0), longHistory(), "модель", context(), { budgetTokens: 3000, charsPerToken: 3.6, maxMessages: 80 });
  // Схемы инструментов едут с каждым запросом, поэтому в бюджет входят и они.
  assert.ok(seen[0] + overhead <= 3000 * 3.6 + 500, "в промпт ушло не больше бюджета: " + (seen[0] + overhead));
});

// Провайдер может отказать не по размеру, а по числу сообщений: короткая история из сотни шагов
// весит немного, но её массив длиннее, чем он принимает. Раньше такой отказ был концом запуска.
test("отказ по числу сообщений лечится уменьшением их предела и повтором", async () => {
  const seen: number[] = [];
  const step = await runBudgetedStep(
    countingProvider(seen, 1),
    manyTurns(60),
    "модель",
    context(),
    { budgetTokens: 100000, charsPerToken: 3.6, maxMessages: 80 },
  );
  assert.equal(step.result.text, "готово");
  assert.equal(seen.length, 2, "провайдер получает вторую попытку");
  assert.ok(seen[1] < seen[0], "во второй попытке сообщений меньше: " + seen[0] + " → " + seen[1]);
  assert.ok(seen[1] <= 40, "в отправленном запросе не больше уменьшенного предела: " + seen[1]);
  assert.equal(step.budget.maxMessages, 40, "уменьшенный предел остаётся на весь запуск");
  assert.ok(step.messages.length <= 40);
});

test("названный провайдером предел берётся с запасом, а не наугад", async () => {
  const seen: number[] = [];
  const body = '[{"origin":"array","code":"too_big","maximum":30,"path":["messages"],"message":"Too big: expected array to have <=30 items"}]';
  const step = await runBudgetedStep(countingProvider(seen, 1, body), manyTurns(60), "модель", context(), {
    budgetTokens: 100000, charsPerToken: 3.6, maxMessages: 80,
  });
  assert.equal(step.budget.maxMessages, 26, "предел провайдера минус запас: " + step.budget.maxMessages);
  assert.ok(seen[1] <= 26, "запрос укладывается в него: " + seen[1]);
});

test("повторный отказ по числу сообщений объясняется словами, а не JSON от валидатора", async () => {
  const seen: number[] = [];
  await assert.rejects(
    runBudgetedStep(countingProvider(seen, 2), manyTurns(60), "модель", context(), { budgetTokens: 100000, charsPerToken: 3.6, maxMessages: 80 }),
    (error: unknown) => {
      assert.ok(error instanceof ContextBudgetError);
      assert.match(error.message, /сообщени/);
      assert.match(error.message, /новый диалог/);
      assert.ok(!error.message.includes("too_big"), "служебный код не должен доходить до пользователя");
      return true;
    },
  );
  assert.equal(seen.length, 2, "попыток ровно две");
});
