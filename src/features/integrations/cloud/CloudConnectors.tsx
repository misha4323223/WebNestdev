import { useEffect, useState } from "react";
import { CLOUD_PROVIDERS } from "./catalog";
import { CloudCard, type CloudConnectionState } from "./CloudCard";

type StatusResponse = {
  providers?: Array<{ id: string; connected: boolean; account: string | null; allowWrites?: boolean }>;
};

type WritesResponse = { error?: string; allowWrites?: boolean };

/**
 * Все облака одной колонкой. Статусы читаются одним запросом: карточкам нужен только факт
 * «подключено / кто / разрешены ли изменения», а отдельные запросы при открытии вкладки —
 * лишняя работа.
 *
 * Разрешение на изменения меняется отдельным запросом, потому что это решение пользователя,
 * а не часть ключа: карточка показывает его состояние и сразу откатывает переключатель, если
 * сервер отказал.
 */
export function CloudConnectors() {
  const [states, setStates] = useState<Record<string, CloudConnectionState>>({});
  const [writesBusy, setWritesBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/cloud")
      .then(response => response.json() as Promise<StatusResponse>)
      .then(data => {
        if (!active) return;
        const next: Record<string, CloudConnectionState> = {};
        for (const item of data.providers ?? []) {
          next[item.id] = { connected: item.connected, account: item.account, allowWrites: item.allowWrites ?? true };
        }
        setStates(next);
      })
      .catch(() => { if (active) setError("Не удалось получить состояние облаков"); });
    return () => { active = false; };
  }, []);

  async function toggleWrites(id: string, allowWrites: boolean) {
    setWritesBusy(id);
    setError("");
    try {
      const response = await fetch("/api/cloud/" + id + "/writes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowWrites }),
      });
      const data = await response.json() as WritesResponse;
      if (!response.ok) throw new Error(data.error ?? "Не удалось изменить разрешение");
      const allowed = data.allowWrites ?? allowWrites;
      setStates(current => ({
        ...current,
        [id]: { ...(current[id] ?? { connected: true, account: null, allowWrites: allowed }), allowWrites: allowed },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить разрешение");
    } finally {
      setWritesBusy(null);
    }
  }

  return <div className="cloud-list">
    <div className="connectors-label">ОБЛАКА</div>
    {error && <div className="connector-notice">{error}</div>}
    {CLOUD_PROVIDERS.map(provider => <CloudCard
      key={provider.id}
      provider={provider}
      state={states[provider.id]}
      onChanged={next => setStates(current => ({
        ...current,
        [provider.id]: { ...(current[provider.id] ?? { allowWrites: true }), ...next },
      }))}
      onToggleWrites={allowed => void toggleWrites(provider.id, allowed)}
      writesBusy={writesBusy === provider.id}
    />)}
  </div>;
}
