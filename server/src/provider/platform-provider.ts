export type PlatformProviderConfig={provider:string;baseUrl:string;model:string;token?:string};

function firstEnv(...names:string[]){
  for(const name of names){
    const value=process.env[name]?.trim();
    if(value)return value;
  }
  return undefined;
}

/**
 * Default AI access for projects that have no provider of their own.
 * PLATFORM_AI_* is the canonical configuration; the legacy AI_* names
 * from .env.example keep working as aliases.
 */
export function getPlatformProviderConfig():PlatformProviderConfig|null{
  const baseUrl=firstEnv("PLATFORM_AI_BASE_URL","AI_BASE_URL");
  const model=firstEnv("PLATFORM_AI_MODEL","AI_MODEL");
  if(!baseUrl||!model)return null;
  const token=firstEnv("PLATFORM_AI_API_KEY","AI_API_KEY");
  return {
    provider:firstEnv("PLATFORM_AI_PROVIDER")??"Платформа WebNestdev",
    baseUrl,
    model,
    ...(token?{token}:{})
  };
}
