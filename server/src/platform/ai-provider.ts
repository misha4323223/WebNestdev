import { getPlatformProviderConfig } from "../provider/platform-provider.js";
import { platformEnvStatus, type PlatformEnvSource } from "./platform-env.js";

/**
 * Публичное состояние главного AI-провайдера для админки. Ключ сюда не попадает даже
 * замаскированным: интерфейсу достаточно знать, задан ли он и откуда взят.
 */
export type PlatformAiProviderStatus = {
  configured: boolean;
  provider: string;
  providerSource: PlatformEnvSource;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  keySource: PlatformEnvSource;
};

export function platformAiProviderStatus(): PlatformAiProviderStatus {
  const config = getPlatformProviderConfig();
  const keys = platformEnvStatus();
  const provider = keys.find(entry => entry.name === "PLATFORM_AI_PROVIDER");
  const key = keys.find(entry => entry.name === "PLATFORM_AI_API_KEY");
  return {
    configured: Boolean(config),
    provider: config?.provider ?? "Платформа NestDev",
    providerSource: provider?.source ?? "none",
    baseUrl: config?.baseUrl ?? "",
    model: config?.model ?? "",
    hasKey: Boolean(config?.token),
    keySource: key?.source ?? "none",
  };
}
