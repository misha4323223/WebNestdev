import { useEffect, useState } from "react";
import { KeyCard, type KeyConnectionState } from "../KeyCard";
import { SERVICE_CATEGORIES, SERVICES } from "./catalog";

type ServiceStatus = {
  id: string;
  name: string;
  category: string;
  connected: boolean;
  account: string | null;
  verification: "check" | "store";
  verificationNote: string;
  env: string[];
};

type StatusResponse = { services?: ServiceStatus[] };

/**
 * Сервисы, которые подключаются ключом: файлы, почта, оплата, AI, карты, CRM. Карточка та же,
 * что у облаков и регистраторов; различие — в подписи: у сервисов без проверки честно написано,
 * что ключ сохраняется без неё, и почему.
 */
export function ServiceConnectors() {
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [states, setStates] = useState<Record<string, KeyConnectionState>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/services")
      .then(response => response.json() as Promise<StatusResponse>)
      .then(data => {
        if (!active) return;
        const nextStatuses: Record<string, ServiceStatus> = {};
        const nextStates: Record<string, KeyConnectionState> = {};
        for (const item of data.services ?? []) {
          nextStatuses[item.id] = item;
          nextStates[item.id] = { connected: item.connected, account: item.account };
        }
        setStatuses(nextStatuses);
        setStates(nextStates);
      })
      .catch(() => { if (active) setError("Не удалось получить состояние сервисов"); });
    return () => { active = false; };
  }, []);

  return <div className="cloud-list">
    {error && <div className="connector-notice">{error}</div>}
    {SERVICE_CATEGORIES.map(category => {
      const services = SERVICES.filter(service => service.category === category.id);
      if (!services.length) return null;
      return <div className="service-group" key={category.id}>
        <div className="connectors-label">{category.name.toUpperCase()}</div>
        <p className="connector-fineprint">{category.note}</p>
        {services.map(service => {
          const status = statuses[service.id];
          const checking = status ? status.verification === "check" : true;
          return <KeyCard
            key={service.id}
            provider={service}
            state={states[service.id]}
            onChanged={next => setStates(current => ({ ...current, [service.id]: next }))}
            endpoint="/api/services"
            consoleLabel="Где взять ключ"
            verificationNote={status?.verificationNote}
            fineprint={checking
              ? "Ключ проверяется до сохранения, шифруется на сервере и не возвращается в браузер. "
              : "Проверка недоступна: ключи шифруются на сервере и не возвращаются в браузер. "}
          />;
        })}
      </div>;
    })}
    <p className="connector-fineprint">Ключи сервиса переносятся в переменные окружения проекта по команде агента — значения не попадают ни в чат, ни в браузер.</p>
  </div>;
}
