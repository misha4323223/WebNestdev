import { useEffect, useState } from "react";
import { apiJson } from "../../lib/api";

type ProviderConfig={provider:string;baseUrl:string;token:string;model:string};
type ModelItem={id:string;name?:string};

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
    try{
      const data=await apiJson<{configured:boolean;provider:string;baseUrl:string;model:string;hasToken:boolean}>(`/api/projects/${encodeURIComponent(projectId)}/provider`);
      setConfig({provider:data.provider,baseUrl:data.baseUrl,model:data.model,token:""});
      setHasToken(data.hasToken);
      if(data.baseUrl){
        const cached=localStorage.getItem(`webnestdev.provider.models.${projectId}`);
        if(cached)try{setModels(JSON.parse(cached))}catch{}
      }
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setLoading(false)}
  })()},[projectId]);

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
      localStorage.setItem(`webnestdev.provider.models.${projectId}`,JSON.stringify(items));
      setConfig(current=>({...current,baseUrl,model:current.model&&items.some(item=>item.id===current.model)?current.model:items[0]?.id??""}));
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
      setHasToken(data.hasToken);setStatus("Настройки сохранены");
      onClose();
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setSaving(false)}
  }

  if(loading)return <section className="settings-panel"><div className="settings-body">Загрузка настроек…</div></section>;

  return <section className="settings-panel">
    <div className="panel-title"><div><span className="eyebrow">AI PROVIDER</span><strong>Настройки модели</strong></div><button className="ghost-button" onClick={onClose}>Закрыть</button></div>
    <div className="settings-body">
      <label>Проект<span>{projectName}</span></label>
      <label>Провайдер<input value={config.provider} onChange={e=>setConfig({...config,provider:e.target.value})} placeholder="OpenRouter, DeepSeek, OpenAI, YandexGPT…"/></label>
      <label>Base URL<input value={config.baseUrl} onChange={e=>setConfig({...config,baseUrl:e.target.value})} placeholder="https://api.example.com/v1" type="url" autoComplete="url"/></label>
      <label>API Key<input value={config.token} onChange={e=>setConfig({...config,token:e.target.value})} placeholder={hasToken?"Ключ сохранён — пусто = оставить прежний":"Введите API key"} type="password" autoComplete="new-password"/></label>
      <div className="model-row">
        <label>Модель<select value={config.model} onChange={e=>setConfig({...config,model:e.target.value})} disabled={loadingModels||models.length===0}>
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
