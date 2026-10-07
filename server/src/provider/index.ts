import type { Provider } from "./provider-types.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export type { Provider,ProviderChunk,ProviderToolCall } from "./provider-types.js";

export type ProviderConfig = {
  provider: string;
  baseUrl: string;
  token?: string;
  model?: string;
};

export function createProvider(config?: Partial<ProviderConfig>): Provider {
  const base = config?.baseUrl?.trim() || process.env.AI_BASE_URL || "http://localhost:11434";
  const key = config?.token || process.env.AI_API_KEY;
  const provider = (config?.provider || process.env.AI_PROVIDER || "ollama").toLowerCase();
  return provider === "ollama"
    ? new OllamaProvider(base, key)
    : new OpenAICompatibleProvider(base, key);
}
