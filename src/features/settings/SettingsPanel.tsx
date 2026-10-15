import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { apiJson } from "../../lib/api";

type ProviderConfig={provider:string;baseUrl:string;token:string;model:string};
type ModelItem={id:string;name?:string};
/**
 * Что браузер помнит о провайдере проекта. Ключ тоже: он остаётся зашифрованным на сервере, а
 * здесь лежит копия того, что ввёл пользователь, — иначе после перезагрузки поле выглядело бы
 * пустым, хотя ключ сохранён.
 */
type StoredProviderConfig={provider:string;baseUrl:string;model:string;token?:string};
type PlatformDefault={available:boolean;providerName:string;model:string};
type TestResult={ok:boolean;source?:string;provider?:string;model?:string;latencyMs?:number;tools?:boolean;text?:string;error?:string;usage?:{promptTokens:number;completionTokens:number}|null};

const providerStorageKey=(projectId:string)=>`webnestdev.provider.config.${projectId}`;
const modelsStorageKey=(projectId:string)=>`webnestdev.provider.models.${projectId}`;

export function SettingsPanel({projectId,projectName,onClose}:{projectId:string;projectName:string;onClose:()=>void}){
  const [config,setConfig]=useState<ProviderConfig>({provider:"",baseUrl:"",token:"",model:""});
  const [models,setModels]=useState<ModelItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadingModels,setLoadingModels]=useState(false);
  const [saving,setSaving]=useState(false);
  const [testing,setTesting]=useState(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");
  const [hasToken,setHasToken]=useState(false);
  const [configured,setConfigured]=useState(false);
  const [removing,setRemoving]=useState(false);
  const [platformDefault,setPlatformDefault]=useState<PlatformDefault|null>(null);
  // Ключ показывается по «глазику»: по умолчанию он скрыт звёздочками.
  const [showToken,setShowToken]=useState(false);

  useEffect(()=>{void (async()=>{
    let cachedConfig:StoredProviderConfig|undefined;
    try{
      const cached=localStorage.getItem(providerStorageKey(projectId));
      if(cached)cachedConfig=JSON.parse(cached) as StoredProviderConfig;
      const cachedModels=localStorage.getItem(modelsStorageKey(projectId));
      if(cachedModels)setModels(JSON.parse(cachedModels) as ModelItem[]);
    }catch{}

    if(cachedConfig){
      setConfig(current=>({
        ...current,
        provider:cachedConfig?.provider??current.provider,
        baseUrl:cachedConfig?.baseUrl??current.baseUrl,
        model:cachedConfig?.model??current.model,
        token:cachedConfig?.token??current.token,
      }));
    }

    try{
      const data=await apiJson<{configured:boolean;provider:string;baseUrl:string;model:string;hasToken:boolean;platformDefault?:PlatformDefault}>(`/api/projects/${encodeURIComponent(projectId)}/provider`);
      const next={provider:data.provider,baseUrl:data.baseUrl,model:data.model};
      // Ключ полем не перетирается: на сервере он есть (`hasToken`), а в поле остаётся копия
      // из этого браузера, чтобы после перезагрузки ключ был виден, а не только упомянут.
      setConfig(current=>({...current,...next}));
      setHasToken(data.hasToken);
      setConfigured(data.configured);
      setPlatformDefault(data.platformDefault??null);
      localStorage.setItem(providerStorageKey(projectId),JSON.stringify(next));
    }catch(e){
      if(!cachedConfig)setError(e instanceof Error?e.message:String(e));
    }finally{setLoading(false)}
  })()},[projectId]);

  function persistConfig(next:StoredProviderConfig){
    try{localStorage.setItem(providerStorageKey(projectId),JSON.stringify(next))}catch{}
  }

  function updateConfig(next:ProviderConfig){
    setConfig(next);
    persistConfig({provider:next.provider,baseUrl:next.baseUrl,model:next.model,token:next.token});
  }

  async function loadModels(){
    const baseUrl=config.baseUrl.trim();
    if(!baseUrl){setError("Укажите Base URL провайдера");return;}
    setLoadingModels(true);setError("");setStatus("");
    try{
      const data=await apiJson<{models:ModelItem[]}>(`/api/providers/models`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({baseUrl,token:config.token.trim()||undefined})
      });
      const items=Array.isArray(data.models)?data.models:[];
      setModels(items);
      localStorage.setItem(modelsStorageKey(projectId),JSON.stringify(items));
      const model=config.model&&items.some(item=>item.id===config.model)?config.model:items[0]?.id??"";
      const next={...config,baseUrl,model};
      setConfig(next);
      persistConfig({provider:next.provider,baseUrl:next.baseUrl,model:next.model,token:next.token});
      setStatus(`Загружено моделей: ${items.length}`);
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setLoadingModels(false)}
  }

  async function save(){
    const baseUrl=config.baseUrl.trim();
    const model=config.model.trim();
    if(!baseUrl){setError("Укажите Base URL провайдера");return;}
    if(!model){setError("Загрузите модели и выберите модель");return;}
    setSaving(true);setError("");setStatus("");
    try{
      const data=await apiJson<{hasToken:boolean}>(`/api/projects/${encodeURIComponent(projectId)}/provider`,{
        method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          provider:config.provider.trim()||"OpenAI-compatible",
          baseUrl,
          model,
          ...(config.token.trim()?{token:config.token.trim()}: {})
        })
      });
      const savedToken=config.token.trim();
      const next={provider:config.provider.trim()||"OpenAI-compatible",baseUrl,model};
      persistConfig({...next,token:savedToken});
      // Поле сохраняет ключ после «Сохранить»: это оно и обещает — ключ есть и после перезагрузки.
      setConfig(current=>({...current,...next,token:savedToken}));
      setHasToken(data.hasToken);
      setStatus(data.hasToken?"Настройки сохранены · API key сохранён":"Настройки сохранены");
      onClose();
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setSaving(false)}
  }

  async function testConnection(){
    setTesting(true);setError("");setStatus("");
    try{
      const data=await apiJson<TestResult>("/api/providers/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(projectId?{projectId}:{})});
      if(data.ok&&data.tools){
        const usage=data.usage?` · токены: ${data.usage.promptTokens} in / ${data.usage.completionTokens} out`:"";
        setStatus(`Подключение работает: ${data.provider} · ${data.model} · ${data.latencyMs} мс · вызов инструментов поддержан${usage}`);
      }else if(data.ok){
        setError(`Модель отвечает (${data.provider} · ${data.model}), но вызов инструментов не подтверждён — агент не сможет выполнять задачи.`);
      }else{
        setError(data.error??"Проверка не удалась");
      }
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setTesting(false)}
  }

  async function resetToPlatform(){
    if(!configured)return;
    if(!window.confirm("Вернуть встроенный ИИ платформы? Свой провайдер будет удалён."))return;
    setRemoving(true);setError("");setStatus("");
    try{
      await apiJson(`/api/projects/${encodeURIComponent(projectId)}/provider`,{method:"DELETE"});
      localStorage.removeItem(providerStorageKey(projectId));
      setConfig({provider:"",baseUrl:"",token:"",model:""});
      setShowToken(false);
      setModels([]);
      setHasToken(false);
      setConfigured(false);
      setStatus("Возвращаемся к встроенному ИИ платформы"+(platformDefault?.providerName?" · "+platformDefault.providerName+" · "+platformDefault.model:""));
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setRemoving(false)}
  }

  if(loading)return <section className="settings-panel"><div className="settings-body">Загрузка настроек…</div></section>;

  return <section className="settings-panel">
    <div className="panel-title"><div><span className="eyebrow">AI-ПРОВАЙДЕР</span><strong>Настройки модели</strong></div><button className="ghost-button" onClick={onClose}>Закрыть</button></div>
    <div className="settings-body">
      <label>Проект<span>{projectName}</span></label>
      {!configured&&platformDefault?.available&&<div className="settings-status">По умолчанию используется модель платформы: {platformDefault.providerName} · {platformDefault.model}. Свой провайдер ниже — опция.</div>}
      <div className="settings-status">{configured
        ? "Этот проект работает через ваш ключ и модель: запуски агента идут за ваш счёт и дневным лимитом платформы не ограничены."
        : "Свой AI-провайдер — это ваш ключ и ваша модель. Запуски агента идут за ваш счёт, поэтому дневной лимит платформы (запуски на встроенной модели) к ним не применяется."}</div>
      <label>Провайдер<input value={config.provider} onChange={e=>updateConfig({...config,provider:e.target.value})} placeholder="OpenRouter, DeepSeek, OpenAI, YandexGPT…"/></label>
      <label>Base URL<input value={config.baseUrl} onChange={e=>updateConfig({...config,baseUrl:e.target.value})} placeholder="https://api.example.com/v1" type="url" autoComplete="url"/></label>
      <label>API-ключ<div className="secret-field">
        <input value={config.token} onChange={e=>updateConfig({...config,token:e.target.value})} placeholder={hasToken?"Ключ сохранён — можно заменить, вставив новый":"Введите API-ключ"} type={showToken?"text":"password"} autoComplete="new-password" spellCheck={false}/>
        <button type="button" className="secret-toggle" onClick={()=>setShowToken(value=>!value)} title={showToken?"Скрыть ключ":"Показать ключ"} aria-label={showToken?"Скрыть API-ключ":"Показать API-ключ"} aria-pressed={showToken}>{showToken?<EyeOff size={14}/>:<Eye size={14}/>}</button>
      </div></label>
      <div className="model-row">
        <label>Модель<select value={config.model} onChange={e=>updateConfig({...config,model:e.target.value})} disabled={loadingModels||models.length===0}>
          {!models.length&&<option value="">Сначала загрузите модели</option>}
          {models.map(item=><option key={item.id} value={item.id}>{item.name??item.id}</option>)}
        </select></label>
        <button className="ghost-button" onClick={()=>void loadModels()} disabled={loadingModels||!config.baseUrl.trim()}>{loadingModels?"Загрузка…":"Загрузить модели"}</button>
      </div>
      {status&&<div className="settings-status">{status}</div>}
      {error&&<div className="settings-error">{error}</div>}
      <div className="model-row">
        <button className="ghost-button" onClick={()=>void testConnection()} disabled={testing}>{testing?"Проверяю модель…":"Проверить подключение"}</button>
        <button className="send-button settings-save" onClick={()=>void save()} disabled={saving||loadingModels}>{saving?"Сохранение…":"Сохранить"}</button>
        {configured&&<button className="ghost-button" onClick={()=>void resetToPlatform()} disabled={removing}>{removing?"Удаляю…":"Вернуть встроенный ИИ"}</button>}
      </div>
    </div>
  </section>;
}
