import { getPlatformEnv } from "../platform/platform-env.js";
import { getPlatformProviderConfig,type PlatformProviderConfig } from "./platform-provider.js";
import { FailoverProvider,type FailoverEndpoint } from "./failover-provider.js";

/**
 * Бесплатная модель тарифа «Старт».
 *
 * У Agnes AI бесплатный доступ к модели, но один аккаунт легко упирается в свой лимит. Поэтому
 * ключи трёх разных аккаунтов идут одной очередью: рабочий ключ остаётся основным, а остальные
 * включаются, когда он отказывает. Платная модель платформы (`PLATFORM_AI_*`, обычно Yandex Cloud
 * AI Studio) стоит последней и только резервом — на платных тарифах она по-прежнему основная.
 *
 * Адрес бесплатной модели — любой OpenAI-совместимый, поэтому `PLATFORM_AI_FREE_PROVIDER` задаёт
 * имя для логов и подписей: после смены провайдера в них не остаётся старого имени.
 *
 * Конфигурация читается через `getPlatformEnv`: значения можно положить в окружение выкатки или
 * в панель «Ключи сервера», и они подхватятся без перезапуска.
 *
 * Генерация изображений — это **не** второй провайдер этой цепи, а отдельный инструмент агента
 * (`provider/image-generation.ts`, инструмент `image.generate`): у него свои имена `PLATFORM_IMAGE_*`
 * и он не меняет ни модель тарифа, ни порядок ключей.
 */
const KEY_NAMES=["PLATFORM_AI_FREE_KEY_1","PLATFORM_AI_FREE_KEY_2","PLATFORM_AI_FREE_KEY_3"] as const;

export type FreeModelConfig={
  providerName:string;
  baseUrl:string;
  model:string;
  keys:string[];
  fallback:PlatformProviderConfig|null;
};

/** Ключи по порядку; пустые и повторы отбрасываются. */
function readKeys():string[]{
  const seen=new Set<string>();
  for(const name of KEY_NAMES){
    const value=getPlatformEnv(name)?.trim();
    if(value)seen.add(value);
  }
  return [...seen];
}

/**
 * `null` означает «бесплатная модель не настроена»: тогда бесплатный тариф работает ровно как
 * раньше — на модели платформы. Провайдер включается только целиком: без адреса, модели и хотя бы
 * одного ключа он не собирается.
 */
export function getFreeModelConfig():FreeModelConfig|null{
  const baseUrl=getPlatformEnv("PLATFORM_AI_FREE_BASE_URL")?.trim();
  const model=getPlatformEnv("PLATFORM_AI_FREE_MODEL")?.trim();
  if(!baseUrl||!model)return null;
  const keys=readKeys();
  if(!keys.length)return null;
  return {
    providerName:getPlatformEnv("PLATFORM_AI_FREE_PROVIDER")?.trim()||"Agnes AI",
    baseUrl,
    model,
    keys,
    fallback:getPlatformProviderConfig(),
  };
}

export type FreeModelRoute={
  provider:FailoverProvider;
  providerName:string;
  baseUrl:string;
  model:string;
  keyCount:number;
  fallback:boolean;
};

/**
 * Готовая цепочка для одного запуска. Состояние пауз у провайдера общее на процесс, поэтому
 * новый экземпляр на каждый запуск не теряет сведения о только что отказавшем ключе.
 */
export function createFreeModelRoute(config=getFreeModelConfig()):FreeModelRoute|null{
  if(!config)return null;
  // Подпись «#2» появляется только там, где ключей больше одного.
  const label=(index:number)=>config.providerName+(config.keys.length>1?" #"+(index+1):"");
  const endpoints:FailoverEndpoint[]=[
    ...config.keys.map((token,index)=>({
      id:"free-"+index,
      label:label(index),
      role:"primary" as const,
      baseUrl:config.baseUrl,
      model:config.model,
      token,
    })),
    ...(config.fallback?[{
      id:"fallback:"+config.fallback.baseUrl+"|"+config.fallback.model,
      label:config.fallback.provider,
      role:"fallback" as const,
      baseUrl:config.fallback.baseUrl,
      model:config.fallback.model,
      ...(config.fallback.token?{token:config.fallback.token}:{}),
    }]:[]),
  ];
  return {
    provider:new FailoverProvider(endpoints),
    providerName:config.providerName,
    baseUrl:config.baseUrl,
    model:config.model,
    keyCount:config.keys.length,
    fallback:Boolean(config.fallback),
  };
}

/** Строка для лога старта: видно, настроена ли бесплатная цепочка и есть ли у неё резерв. */
export function describeFreeModelRoute(){
  const config=getFreeModelConfig();
  if(!config)return "бесплатный тариф: PLATFORM_AI_FREE_* не заданы, работает модель платформы";
  return "бесплатный тариф: "+config.providerName+" ("+config.model+"), ключей "+config.keys.length+
    (config.fallback?", резерв — "+config.fallback.provider:" без резерва");
}
