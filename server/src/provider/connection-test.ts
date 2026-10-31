import { createProvider } from "./index.js";
import { reasoningSupport, type ReasoningSupport } from "./openai-compatible-provider.js";

export type ProviderConnectionTestResult = {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  tools?: boolean;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  text?: string;
  usage?: { promptTokens: number; completionTokens: number } | null;
  reasoning?: ReasoningSupport | null;
  error?: string;
};

/**
 * Настоящий пробный вызов с инструментом. Проверяет не только доступность адреса, но и то,
 * что выбранная модель умеет вызывать инструменты — без этого агент не сможет работать.
 * Ключ передаётся только в заголовок запроса и никогда не возвращается в результате.
 */
export async function testProviderConnection(
  config: { provider: string; baseUrl: string; model: string; token?: string },
  timeoutMs = 20_000,
): Promise<ProviderConnectionTestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = "";
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  try {
    const provider = createProvider(config);
    const tools = [{
      type: "function",
      function: {
        name: "ping",
        description: "Проверочный инструмент. Вызови его с аргументом value=\"ok\".",
        parameters: { type: "object", properties: { value: { type: "string" } }, additionalProperties: true },
      },
    }];
    for await (const chunk of provider.stream(
      [{ role: "user", content: "Проверка связи: вызови инструмент ping с аргументом value=\"ok\"." }],
      config.model,
      tools,
      controller.signal,
    )) {
      if (chunk.type === "text") text += chunk.text;
      else if (chunk.type === "tool_call") toolCalls.push({ name: chunk.call.name, arguments: chunk.call.arguments });
      else if (chunk.type === "usage") usage = { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens };
    }
    return {
      ok: true,
      provider: config.provider,
      model: config.model,
      latencyMs: Date.now() - started,
      tools: toolCalls.length > 0,
      toolCalls,
      text: text.slice(0, 400),
      usage,
      reasoning: reasoningSupport(config.baseUrl, config.model),
    };
  } catch (failure) {
    const raw = failure instanceof Error ? failure.message : String(failure);
    return {
      ok: false,
      provider: config.provider,
      model: config.model,
      latencyMs: Date.now() - started,
      error: /abort/i.test(raw) ? "Провайдер не ответил за 20 секунд" : raw,
      reasoning: reasoningSupport(config.baseUrl, config.model),
    };
  } finally {
    clearTimeout(timer);
  }
}
