import type { Provider } from "./provider-types.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { RoutedProvider } from "./routed-provider.js";
import { isUpstreamRouted, type UpstreamRouting } from "./upstream-routing.js";

export type { Provider,ProviderChunk,ProviderStreamOptions,ProviderToolCall,UpstreamProviderRequest } from "./provider-types.js";
export type { UpstreamRouting, UpstreamRoutingMode, UpstreamMaxPrice } from "./upstream-routing.js";

export type ProviderConfig = {
  provider: string;
  baseUrl: string;
  token?: string;
  model?: string;
  /** Выбор upstream-провайдера внутри шлюза; пусто/auto — шлюз выбирает сам. */
  routing?: UpstreamRouting;
};

export function createProvider(config?: Partial<ProviderConfig>): Provider {
  const base = config?.baseUrl?.trim();
  if (!base) {
    throw new Error("Base URL провайдера не настроен для этого проекта");
  }
  const routing = config?.routing;
  if (routing && isUpstreamRouted(routing)) {
    return new RoutedProvider(base, config?.token, routing);
  }
  return new OpenAICompatibleProvider(base, config?.token);
}
