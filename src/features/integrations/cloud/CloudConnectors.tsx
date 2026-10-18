import { useEffect, useState } from "react";
import { CLOUD_PROVIDERS } from "./catalog";
import { CloudCard, type CloudConnectionState } from "./CloudCard";

type StatusResponse = {
  providers?: Array<{ id: string; connected: boolean; account: string | null }>;
};

/**
 * Все облака одной колонкой. Статусы читаются одним запросом: карточкам нужен только факт
 * «подключено / кто», а пять отдельных запросов при открытии вкладки — лишняя работа.
 */
export function CloudConnectors() {
  const [states, setStates] = useState<Record<string, CloudConnectionState>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/cloud")
      .then(response => response.json() as Promise<StatusResponse>)
      .then(data => {
        if (!active) return;
        const next: Record<string, CloudConnectionState> = {};
        for (const item of data.providers ?? []) next[item.id] = { connected: item.connected, account: item.account };
        setStates(next);
      })
      .catch(() => { if (active) setError("Не удалось получить состояние облаков"); });
    return () => { active = false; };
  }, []);

  return <div className="cloud-list">
    <div className="connectors-label">ОБЛАКА</div>
    {error && <div className="connector-notice">{error}</div>}
    {CLOUD_PROVIDERS.map(provider => <CloudCard
      key={provider.id}
      provider={provider}
      state={states[provider.id]}
      onChanged={next => setStates(current => ({ ...current, [provider.id]: next }))}
    />)}
  </div>;
}
