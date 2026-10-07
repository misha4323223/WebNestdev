import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";

type ProviderConfig={provider:string;baseUrl:string;token:string;model:string};
type ModelItem={id:string;name?:string};
type StoredProviderConfig={provider:string;baseUrl:string;model:string};

const providerStorageKey=(projectId:string)=>`webnestdev.provider.config.${projectId}`;
const modelsStorageKey=(projectId:string)=>`webnestdev.provider.models.${projectId}`;

export function SettingsPanel({projectId,projectName,onClose}:{projectId:string;projectName:string;onClose:()=>void}){
  const [config,setConfig]=useState<ProviderConfig>({provider:"",baseUrl:"",token:"",model:""});
  const [models,setModels]=useState<ModelItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [loadingModels,setLoadingModels]=useState(false);
  const [saving,setSaving]=useState(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");
  const [hasToken,setHasToken]=useState(false);

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
      }));
    }

    try{
      const data=await apiJson<{configured:boolean;provider:string;baseUrl:string;model:string;hasToken:boolean}>(`/api/projects/${encodeURIComponent(projectId)}/provider`);
      const next={provider:data.provider,baseUrl:data.baseUrl,model:data.model};
      setConfig(current=>({...current,...next,token:""}));
      setHasToken(data.hasToken);
      localStorage.setItem(providerStorageKey(projectId),JSON.stringify(next));
    }catch(e){
      if(!cachedConfig)setError(e instanceof Error?e.message:String(e));
    }finally{setLoading(false)}
  })()},[projectId]);

  function persistConfig(next:StoredProviderConfig){
    localStorage.setItem(providerStorageKey(projectId),JSON.stringify(next));
  }

  function updateConfig(next:ProviderConfig){
    setConfig(next);
    persistConfig({provider:next.provider,baseUrl:next.baseUrl,model:next.model});
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
      persistConfig({provider:next.provider,baseUrl:next.baseUrl,model:next.model});
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
      const next={provider:config.provider.trim()||"OpenAI-compatible",baseUrl,model};
      persistConfig(next);
      setConfig(current=>({...current,...next,token:""}));
      setHasToken(data.hasToken);
      setStatus(data.hasToken?"Настройки сохранены · API key сохранён":"Настройки сохранены");
      onClose();
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setSaving(false)}
  }

  if(loading)return <section className="settings-panel"><div className="settings-body">Загрузка настроек…</div></section>;

  return <section className="settings-panel">
    <div className="panel-title"><div><span className="eyebrow">AI PROVIDER</span><strong>Настройки модели</strong></div><button className="ghost-button" onClick={onClose}>Закрыть</button></div>
    <div className="settings-body">
      <label>Проект<span>{projectName}</span></label>
      <label>Провайдер<input value={config.provider} onChange={e=>updateConfig({...config,provider:e.target.value})} placeholder="OpenRouter, DeepSeek, OpenAI, YandexGPT…"/></label>
      <label>Base URL<input value={config.baseUrl} onChange={e=>updateConfig({...config,baseUrl:e.target.value})} placeholder="https://api.example.com/v1" type="url" autoComplete="url"/></label>
      <label>API Key<input value={config.token} onChange={e=>setConfig({...config,token:e.target.value})} placeholder={hasToken?"Ключ сохранён — повторно вводить не нужно":"Введите API key"} type="password" autoComplete="new-password"/></label>
      <div className="model-row">
        <label>Модель<select value={config.model} onChange={e=>updateConfig({...config,model:e.target.value})} disabled={loadingModels||models.length===0}>
          {!models.length&&<option value="">Сначала загрузите модели</option>}
          {models.map(item=><option key={item.id} value={item.id}>{item.name??item.id}</option>)}
        </select></label>
        <button className="ghost-button" onClick={()=>void loadModels()} disabled={loadingModels||!config.baseUrl.trim()}>{loadingModels?"Загрузка…":"Загрузить модели"}</button>
      </div>
      {status&&<div className="settings-status">{status}</div>}
      {error&&<div className="settings-error">{error}</div>}
      <button className="send-button settings-save" onClick={()=>void save()} disabled={saving||loadingModels}>{saving?"Сохранение…":"Сохранить"}</button>
    </div>
  </section>;
}
