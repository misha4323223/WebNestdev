import { getPlatformEnv } from "../platform/platform-env.js";

export type PlatformProviderConfig={provider:string;baseUrl:string;model:string;token?:string};

function firstEnv(...names:string[]){
  for(const name of names){
    const value=getPlatformEnv(name)?.trim();
    if(value)return value;
  }
  return undefined;
}

/**
 * Default AI access for projects that have no provider of their own.
 * PLATFORM_AI_* is the canonical configuration; the legacy AI_* names
 * from .env.example keep working as aliases.
 *
 * Значения читаются через getPlatformEnv, поэтому ключ модели платформы можно
 * поставить в панели «Ключи сервера» — без правки .env и перезапуска.
 */
export function getPlatformProviderConfig():PlatformProviderConfig|null{
  const baseUrl=firstEnv("PLATFORM_AI_BASE_URL","AI_BASE_URL");
  const model=firstEnv("PLATFORM_AI_MODEL","AI_MODEL");
  if(!baseUrl||!model)return null;
  const token=firstEnv("PLATFORM_AI_API_KEY","AI_API_KEY");
  return {
    provider:firstEnv("PLATFORM_AI_PROVIDER")??"Платформа NestDev",
    baseUrl,
    model,
    ...(token?{token}:{})
  };
}
