import type { Provider } from "./provider-types.js";
import { OllamaProvider } from "./ollama-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

export type { Provider,ProviderChunk,ProviderToolCall } from "./provider-types.js";

export function createProvider():Provider{
  const base=process.env.AI_BASE_URL??"http://localhost:11434";
  const key=process.env.AI_API_KEY;
  return (process.env.AI_PROVIDER??"ollama")==="ollama"
    ?new OllamaProvider(base,key)
    :new OpenAICompatibleProvider(base,key);
}
