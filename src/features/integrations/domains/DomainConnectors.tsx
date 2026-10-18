import { useEffect, useState } from "react";
import { DOMAIN_REGISTRARS } from "./catalog";
import { KeyCard, type KeyConnectionState } from "../KeyCard";

type StatusResponse = {
  providers?: Array<{ id: string; connected: boolean; account: string | null }>;
};

/**
 * Регистраторы одной колонкой, как облака. Кнопка «Подключить» раскрывает шаги и ссылку на
 * кабинет, где выдаётся пароль для API или токен; доступ проверяется чтением списка доменов.
 *
 * Покупка и DNS здесь не выполняются — платформа только читает кабинет, поэтому под списком
 * стоит честная подпись, а не обещание «зарегистрировать в один клик».
 */
export function DomainConnectors() {
  const [states, setStates] = useState<Record<string, KeyConnectionState>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/domains")
      .then(response => response.json() as Promise<StatusResponse>)
      .then(data => {
        if (!active) return;
        const next: Record<string, KeyConnectionState> = {};
        for (const item of data.providers ?? []) next[item.id] = { connected: item.connected, account: item.account };
        setStates(next);
      })
      .catch(() => { if (active) setError("Не удалось получить состояние регистраторов"); });
    return () => { active = false; };
  }, []);

  return <div className="cloud-list">
    <div className="connectors-label">ДОМЕНЫ</div>
    {error && <div className="connector-notice">{error}</div>}
    {DOMAIN_REGISTRARS.map(registrar => <KeyCard
      key={registrar.id}
      provider={registrar}
      state={states[registrar.id]}
      onChanged={next => setStates(current => ({ ...current, [registrar.id]: next }))}
      endpoint="/api/domains"
      consoleLabel="Где получить доступ"
    />)}
    <p className="connector-fineprint">Регистрация, продление и DNS остаются в кабинете регистратора: платформа читает список доменов и не покупает их за вас.</p>
  </div>;
}
