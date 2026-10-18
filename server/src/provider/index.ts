import type { Provider } from "./provider-types.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export type { Provider,ProviderChunk,ProviderStreamOptions,ProviderToolCall } from "./provider-types.js";

export type ProviderConfig = {
  provider: string;
  baseUrl: string;
  token?: string;
  model?: string;
};

export function createProvider(config?: Partial<ProviderConfig>): Provider {
  const base = config?.baseUrl?.trim();
  if (!base) {
    throw new Error("Base URL провайдера не настроен для этого проекта");
  }
  return new OpenAICompatibleProvider(base, config?.token);
}
