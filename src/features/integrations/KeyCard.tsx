import { useState, type ReactNode } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { BrandLogo, type BrandId } from "../../components/BrandLogo";

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
  /**
   * Страница, где пользователь ВЫДАЁТ ключ, а не главная сервиса: ссылка «Где взять ключ»
   * ведёт ровно туда, где создаётся ключ или пароль для API. Если кабинет не даёт постоянной
   * ссылки на этот раздел, ведём на страницу входа кабинета или на инструкцию провайдера
   * именно про выдачу ключа — но не на витрину сервиса.
   */
  keyUrl: string;
  docsUrl: string;
  tagline: string;
  fields: KeyProviderField[];
  steps: string[];
  /** Официальный логотип сервиса — единственное, что показывает заголовок карточки. */
  logo: BrandId;
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
export function KeyCard({ provider, state, onChanged, endpoint, keyLabel = "Где взять ключ", verificationNote, fineprint, accessNotice, writes }: {
  provider: KeyProviderInfo;
  state: KeyConnectionState | undefined;
  onChanged: (next: KeyConnectionState) => void;
  /** Префикс API, к которому относится карточка, например /api/cloud. */
  endpoint: string;
  keyLabel?: string;
  /** Что именно проверяется при сохранении (или почему проверки нет). */
  verificationNote?: string;
  /** Подпись вместо стандартной — для сервисов без проверки ключа. */
  fineprint?: string;
  /** Что пользователь даёт подключением: показывается до сохранения ключа, а не после. */
  accessNotice?: ReactNode;
  /**
   * Разрешение на изменения. Если передано, у карточки есть переключатель: до подключения —
   * черновик (включён), после — состояние с сервера. Так пользователь решает про доступ до
   * того, как ключ сохранён, а не узнаёт о нём потом.
   */
  writes?: { allowed: boolean; busy?: boolean; onToggle: (allowed: boolean) => void };
}) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Черновик разрешения до подключения: по умолчанию включён, как и на сервере. */
  const [writesDraft, setWritesDraft] = useState(true);
  const connected = Boolean(state?.connected);
  const allowWrites = writes ? (connected ? writes.allowed : writesDraft) : undefined;

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
        body: JSON.stringify({ fields, ...(allowWrites === undefined ? {} : { allowWrites }) }),
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
      <BrandLogo brand={provider.logo} size={32} />
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
      <a className="ghost-button" href={provider.keyUrl} target="_blank" rel="noreferrer">{keyLabel} <ExternalLink size={11}/></a>
    </div>}

    {connected && writes && <label className="connector-write">
      <span>
        <strong>Разрешить агенту изменять ресурсы</strong>
        <small>{writes.allowed
          ? "Включено: агент создаёт, меняет и удаляет ресурсы по вашей команде."
          : "Выключено: агент только читает."}</small>
      </span>
      <span className="switch"><input type="checkbox" checked={writes.allowed} disabled={busy || writes.busy} onChange={event => writes.onToggle(event.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></span>
    </label>}

    {error && <div className="connector-notice">{error}</div>}

    {open && <div className="connector-key">
      {!connected && accessNotice && <div className="connector-hint">{accessNotice}</div>}

      {!connected && writes && <label className="connector-write">
        <span>
          <strong>Разрешить агенту изменять ресурсы</strong>
          <small>{writesDraft
            ? "Включено: агент создаёт, меняет и удаляет ресурсы по вашей команде."
            : "Выключено: агент только читает."}</small>
        </span>
        <span className="switch"><input type="checkbox" checked={writesDraft} disabled={busy} onChange={event => setWritesDraft(event.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></span>
      </label>}

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
        <a className="ghost-button" href={provider.keyUrl} target="_blank" rel="noreferrer">{keyLabel} <ExternalLink size={11}/></a>
      </div>

      <p className="connector-fineprint">{(fineprint ?? "Доступ проверяется до сохранения, шифруется на сервере и не возвращается в браузер. ")}<a href={provider.docsUrl} target="_blank" rel="noreferrer">Документация</a></p>
    </div>}
  </article>;
}
