import { useEffect, useState } from "react";
import { DOMAIN_REGISTRARS } from "./catalog";
import { KeyCard, type KeyConnectionState } from "../KeyCard";

type StatusResponse = {
  providers?: Array<{ id: string; connected: boolean; account: string | null; allowWrites?: boolean }>;
};

type WritesResponse = { error?: string; allowWrites?: boolean };

/**
 * Регистраторы одной колонкой, как облака. Кнопка «Подключить» раскрывает шаги и ссылку на
 * страницу кабинета, где выдаётся пароль для API или токен; доступ проверяется чтением списка
 * доменов.
 *
 * Разрешение на изменения устроено так же, как у облаков: пароль кабинета открывает и DNS,
 * поэтому карточка спрашивает об этом до сохранения ключа, а переключатель в карточке меняет
 * только это поле. Без разрешения агент читает кабинет и не трогает записи.
 */
export function DomainConnectors() {
  const [states, setStates] = useState<Record<string, KeyConnectionState>>({});
  const [writesBusy, setWritesBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/domains")
      .then(response => response.json() as Promise<StatusResponse>)
      .then(data => {
        if (!active) return;
        const next: Record<string, KeyConnectionState> = {};
        for (const item of data.providers ?? []) {
          next[item.id] = { connected: item.connected, account: item.account, allowWrites: item.allowWrites ?? true };
        }
        setStates(next);
      })
      .catch(() => { if (active) setError("Не удалось получить состояние регистраторов"); });
    return () => { active = false; };
  }, []);

  async function toggleWrites(id: string, allowWrites: boolean) {
    setWritesBusy(id);
    setError("");
    try {
      const response = await fetch("/api/domains/" + id + "/writes", {
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
    {error && <div className="connector-notice">{error}</div>}
    {DOMAIN_REGISTRARS.map(registrar => <KeyCard
      key={registrar.id}
      provider={registrar}
      state={states[registrar.id]}
      onChanged={next => setStates(current => ({ ...current, [registrar.id]: next }))}
      endpoint="/api/domains"
      writes={{
        allowed: states[registrar.id]?.allowWrites ?? true,
        busy: writesBusy === registrar.id,
        onToggle: allowed => void toggleWrites(registrar.id, allowed),
      }}
    />)}
    <p className="connector-fineprint">
      С включённым разрешением агент настраивает DNS (A-записи на сервер, TXT-подтверждения) в
      этом кабинете. Регистрация, продление и оплата остаются за вами в кабинете регистратора.
    </p>
  </div>;
}
