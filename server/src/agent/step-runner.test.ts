import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderChunk } from "../provider.js";
import { ProviderHttpError } from "../provider/provider-errors.js";
import type { ChatMessage } from "../types.js";
import type { AgentContext } from "./types.js";
import { ContextBudgetError } from "./context-budget.js";
import { runBudgetedStep, toolDefinitionChars, type StepBudget } from "./step-runner.js";

/** The production body: input 932489 tokens against a 524288-token model. */
const CONTEXT_BODY = '{"error":{"message":"ContextWindowExceededError: The input (932489 tokens) is longer than the model\'s context length (524288 tokens).","type":"BadRequestError","code":"400"}}';

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
  const budget: StepBudget = { budgetTokens: 20000, charsPerToken: 3.6 };
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
    runBudgetedStep(refusingProvider(seen, 2), longHistory(), "agnes-3.0-flash", context(), { budgetTokens: 20000, charsPerToken: 3.6 }),
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
  const step = await runBudgetedStep(refusingProvider(seen, 0, { promptTokens: 50000, completionTokens: 10 }), longHistory(), "модель", context(), { budgetTokens: 10000, charsPerToken: 3.6 });
  assert.ok(step.budget.charsPerToken !== 3.6, "оценка символов на токен откалибрована: " + step.budget.charsPerToken);
  // Провайдер прислал больше, чем бюджет: потолок не поднимается, а следующий отбор отправит меньше.
  assert.ok(step.budget.budgetTokens <= 10000, "бюджет не вырос: " + step.budget.budgetTokens);
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
    runBudgetedStep(provider, longHistory(), "модель", context(), { budgetTokens: 20000, charsPerToken: 3.6 }),
    (error: unknown) => error instanceof ProviderHttpError && error.code === "AUTH",
  );
  assert.equal(attempts, 1);
});

test("длинная история подрезается до отправки, а не после отказа", async () => {
  const seen: number[] = [];
  const overhead = toolDefinitionChars();
  await runBudgetedStep(refusingProvider(seen, 0), longHistory(), "модель", context(), { budgetTokens: 3000, charsPerToken: 3.6 });
  // Схемы инструментов едут с каждым запросом, поэтому в бюджет входят и они.
  assert.ok(seen[0] + overhead <= 3000 * 3.6 + 500, "в промпт ушло не больше бюджета: " + (seen[0] + overhead));
});
