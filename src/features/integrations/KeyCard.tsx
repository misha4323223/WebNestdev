import { useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";

export type KeyProviderField = {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
  /** Необязательное поле: пустым оставлять можно, сервер подставит значение по умолчанию. */
  optional?: boolean;
};

/**
 * Описание сервиса, который подключается ключом или паролем из кабинета. Карточка облака и
 * карточка регистратора отличаются только адресом API и подписью ссылки, поэтому форма,
 * проверка и состояния живут в одном месте.
 */
export type KeyProviderInfo = {
  id: string;
  name: string;
  consoleUrl: string;
  docsUrl: string;
  tagline: string;
  fields: KeyProviderField[];
  steps: string[];
  color: string;
  mark: string;
};

export type KeyConnectionState = {
  connected: boolean;
  account: string | null;
};

/**
 * Одна карточка подключения. В свёрнутом виде — только название и кнопка: инструкция,
 * поля и ссылки живут в раскрывающейся части, поэтому список остаётся списком, а не
 * простынёй текста.
 */
export function KeyCard({ provider, state, onChanged, endpoint, consoleLabel = "Открыть консоль", verificationNote, fineprint }: {
  provider: KeyProviderInfo;
  state: KeyConnectionState | undefined;
  onChanged: (next: KeyConnectionState) => void;
  /** Префикс API, к которому относится карточка, например /api/cloud. */
  endpoint: string;
  consoleLabel?: string;
  /** Что именно проверяется при сохранении (или почему проверки нет). */
  verificationNote?: string;
  /** Подпись вместо стандартной — для сервисов без проверки ключа. */
  fineprint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = Boolean(state?.connected);

  function setField(key: string, value: string) {
    setFields(current => ({ ...current, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint + "/" + provider.id, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const data = await response.json() as { error?: string; account?: string | null };
      if (!response.ok) throw new Error(data.error ?? "Сервис отклонил доступ");
      setFields({});
      setOpen(false);
      onChanged({ connected: true, account: data.account ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить доступ");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await fetch(endpoint + "/" + provider.id + "/disconnect", { method: "POST" });
      setOpen(false);
      onChanged({ connected: false, account: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отключить сервис");
    } finally {
      setBusy(false);
    }
  }

  const ready = provider.fields.every(field => field.optional || (fields[field.key] ?? "").trim().length > 0);

  return <article className={"connector key-card" + (connected ? " is-connected" : "")}>
    <div className="connector-head">
      <span className="connector-icon provider-mark" style={{ background: provider.color }} aria-hidden="true">{provider.mark}</span>
      <div className="connector-meta">
        <strong>{provider.name}</strong>
        <span className="connector-state">{connected ? <><span className="connector-dot"/>{state?.account ? "Подключено · " + state.account : "Подключено"}</> : provider.tagline}</span>
      </div>
      {connected
        ? <button className="ghost-button connector-action" onClick={() => void disconnect()} disabled={busy}>Отключить</button>
        : <button className="connector-action connector-connect" onClick={() => setOpen(value => !value)} disabled={busy}>{open ? "Скрыть" : "Подключить"}</button>}
    </div>

    {connected && <div className="connector-actions-row">
      <button className="ghost-button" onClick={() => setOpen(value => !value)}>{open ? "Скрыть доступ" : "Заменить доступ"}</button>
      <a className="ghost-button" href={provider.consoleUrl} target="_blank" rel="noreferrer">{consoleLabel} <ExternalLink size={11}/></a>
    </div>}

    {error && <div className="connector-notice">{error}</div>}

    {open && <div className="connector-key">
      {!connected && <ol className="connector-steps">
        {provider.steps.map(step => <li key={step}>{step}</li>)}
      </ol>}

      {verificationNote && <p className="connector-fineprint">{verificationNote}</p>}

      {provider.fields.map(field => <label key={field.key}>
        <span><KeyRound size={12}/> {field.label}</span>
        {field.multiline
          ? <textarea rows={4} value={fields[field.key] ?? ""} placeholder={field.placeholder} onChange={event => setField(field.key, event.target.value)}/>
          : <input type={field.secret ? "password" : "text"} value={fields[field.key] ?? ""} placeholder={field.placeholder} autoComplete="off" spellCheck={false} onChange={event => setField(field.key, event.target.value)}/>}
      </label>)}

      <div className="connector-actions-row">
        <button className="connector-action connector-connect" onClick={() => void save()} disabled={!ready || busy}>{busy ? "Проверяем доступ…" : "Сохранить"}</button>
        <a className="ghost-button" href={provider.consoleUrl} target="_blank" rel="noreferrer">{consoleLabel} <ExternalLink size={11}/></a>
      </div>

      <p className="connector-fineprint">{(fineprint ?? "Доступ проверяется до сохранения, шифруется на сервере и не возвращается в браузер. ")}<a href={provider.docsUrl} target="_blank" rel="noreferrer">Документация</a></p>
    </div>}
  </article>;
}
