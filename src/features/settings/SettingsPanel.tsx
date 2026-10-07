import { useEffect, useState } from "react";

type ProviderConfig = {
  provider: string;
  baseUrl: string;
  token: string;
  model: string;
};

type ModelItem = { id: string; name?: string };

const STORAGE_KEY = "webnestdev.provider";

function loadConfig(): ProviderConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { provider: "", baseUrl: "", token: "", model: "", ...JSON.parse(raw) };
  } catch {}
  return { provider: "", baseUrl: "", token: "", model: "" };
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

async function fetchModels(baseUrl: string, token: string): Promise<ModelItem[]> {
  const root = normalizeBaseUrl(baseUrl);
  if (!root) throw new Error("Укажите Base URL");
  const response = await fetch(root + "/models", {
    headers: token.trim() ? { Authorization: "Bearer " + token.trim() } : {},
  });
  if (!response.ok) {
    throw new Error(`Не удалось получить модели: HTTP ${response.status}`);
  }
  const data = await response.json();
  const models = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(models)) throw new Error("Провайдер вернул неизвестный формат списка моделей");
  return models
    .map((item: unknown) => {
      if (typeof item === "string") return { id: item, name: item };
      if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
        return { id: item.id, name: typeof item.name === "string" ? item.name : item.id };
      }
      return null;
    })
    .filter((item): item is ModelItem => Boolean(item));
}

export function SettingsPanel({projectName,onClose}:{projectName:string;onClose:()=>void}){
  const [config,setConfig]=useState<ProviderConfig>(loadConfig);
  const [models,setModels]=useState<ModelItem[]>([]);
  const [loadingModels,setLoadingModels]=useState(false);
  const [status,setStatus]=useState("");
  const [error,setError]=useState("");

  useEffect(() => {
    if (!config.baseUrl) return;
    try {
      const cached = localStorage.getItem(STORAGE_KEY + ".models");
      if (cached) setModels(JSON.parse(cached));
    } catch {}
  }, []);

  async function loadModels() {
    setLoadingModels(true);
    setError("");
    setStatus("");
    try {
      const items = await fetchModels(config.baseUrl, config.token);
      setModels(items);
      localStorage.setItem(STORAGE_KEY + ".models", JSON.stringify(items));
      setConfig(current => ({
        ...current,
        model: current.model && items.some(item => item.id === current.model) ? current.model : items[0]?.id ?? "",
      }));
      setStatus(`Загружено моделей: ${items.length}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    localStorage.setItem("webnestdev.model", config.model);
    onClose();
  }

  return <section className="settings-panel">
    <div className="panel-title">
      <div><span className="eyebrow">SETTINGS</span><strong>Настройки проекта</strong></div>
      <button className="ghost-button" onClick={onClose}>Закрыть</button>
    </div>
    <div className="settings-body">
      <label>Проект<span>{projectName}</span></label>

      <label>Провайдер
        <input
          value={config.provider}
          onChange={e=>setConfig({...config,provider:e.target.value})}
          placeholder="Например: YandexGPT, OpenAI, OpenRouter"
        />
      </label>

      <label>Base URL
        <input
          value={config.baseUrl}
          onChange={e=>setConfig({...config,baseUrl:e.target.value})}
          placeholder="https://api.example.com/v1"
          type="url"
        />
      </label>

      <label>API Token
        <input
          value={config.token}
          onChange={e=>setConfig({...config,token:e.target.value})}
          placeholder="Введите токен"
          type="password"
          autoComplete="off"
        />
      </label>

      <div className="model-row">
        <label>Модель
          <select
            value={config.model}
            onChange={e=>setConfig({...config,model:e.target.value})}
            disabled={loadingModels || models.length === 0}
          >
            {!models.length && <option value="">Сначала загрузите модели</option>}
            {models.map(item=><option key={item.id} value={item.id}>{item.name ?? item.id}</option>)}
          </select>
        </label>
        <button className="ghost-button" onClick={loadModels} disabled={loadingModels || !config.baseUrl}>
          {loadingModels ? "Загрузка…" : "Загрузить модели"}
        </button>
      </div>

      {status && <div className="settings-status">{status}</div>}
      {error && <div className="settings-error">{error}</div>}

      <button className="send-button settings-save" onClick={save}>Сохранить</button>
    </div>
  </section>;
}
