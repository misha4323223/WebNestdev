import { useState } from "react";
import { ChevronDown, ExternalLink, KeyRound, Minus, Plus, RefreshCw } from "lucide-react";
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
  /** Официальный логотип сервиса — единственное, что показывает заголовок карточки. */
  logo: BrandId;
};

export type KeyConnectionState = {
  connected: boolean;
  account: string | null;
  /** Ответ облака после сохранения: иначе карточка покажет старое разрешение на изменения. */
  allowWrites?: boolean;
};

/**
 * Одна карточка подключения. В свёрнутом виде — только название и кнопка: поля и ссылки живут
 * в раскрывающейся части, поэтому список остаётся списком, а не простынёй текста.
 *
 * Подсказок «где нажать в кабинете» и «что мы проверим» в карточке нет намеренно: путь к ключу
 * объясняет страница по кнопке «Где взять ключ», а проверка видна по самому действию. Поэтому
 * раскрытая карточка — это сначала поля ключа, потом переключатель разрешения, потом действие.
 */
export function KeyCard({ provider, state, onChanged, endpoint, keyLabel = "Где взять ключ", fineprint, writes, onRefresh, refreshing }: {
  provider: KeyProviderInfo;
  state: KeyConnectionState | undefined;
  onChanged: (next: KeyConnectionState) => void;
  /** Префикс API, к которому относится карточка, например /api/cloud. */
  endpoint: string;
  keyLabel?: string;
  /** Подпись вместо стандартной — для сервисов без проверки ключа. */
  fineprint?: string;
  /**
   * Разрешение на изменения. Если передано, у карточки есть переключатель: до подключения —
   * черновик (включён), после — состояние с сервера. Так пользователь решает про доступ до
   * того, как ключ сохранён, а не узнаёт о нём потом.
   */
  writes?: { allowed: boolean; busy?: boolean; onToggle: (allowed: boolean) => void };
  /** Перечитать живую подпись (число серверов, домены, аккаунт), не меняя ключ. */
  onRefresh?: () => void;
  refreshing?: boolean;
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
      const data = await response.json() as { error?: string; account?: string | null; allowWrites?: boolean };
      if (!response.ok) throw new Error(data.error ?? "Сервис отклонил доступ");
      setFields({});
      setOpen(false);
      // Разрешение на изменения возвращается вместе с подключением: без него только что
      // сохранённое «выключено» выглядело бы включённым до перезагрузки страницы.
      onChanged({
        connected: true,
        account: data.account ?? null,
        ...(typeof data.allowWrites === "boolean" ? { allowWrites: data.allowWrites } : {}),
      });
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
      const response = await fetch(endpoint + "/" + provider.id + "/disconnect", { method: "POST" });
      // Без этой проверки ответ 500 выглядел бы как успешное отключение: карточка гасла бы,
      // хотя ключ остался на сервере.
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "Сервис не подтвердил отключение");
      }
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
      {/* Логотип и название — одна кнопка: она делает то же, что раньше делала кнопка
          «Подключить» справа. У подключённой карточки клик раскрывает замену доступа, а
          «Отключить» остаётся отдельной кнопкой, чтобы случайный клик не снял доступ. */}
      <button
        type="button"
        className="connector-identity"
        onClick={() => setOpen(value => !value)}
        disabled={busy}
        aria-expanded={open}
        aria-label={(connected ? "Доступ к " : "Подключить ") + provider.name}
      >
        <BrandLogo brand={provider.logo} />
        <span className="connector-meta">
          <strong>{provider.name}</strong>
          <span className="connector-state">{connected ? <><span className="connector-dot"/>{state?.account ? "Подключено · " + state.account : "Подключено"}</> : provider.tagline}</span>
        </span>
        {/* Кружок — не отдельная кнопка, а часть той же строки: он показывает, что произойдёт
            по нажатию (плюс раскрывает подключение, шеврон — доступ к настройкам). */}
        <span className={"connector-socket" + (connected ? " is-on" : "") + (open ? " is-open" : "")} aria-hidden="true">
          {connected ? <ChevronDown size={14} className="connector-caret"/> : open ? <Minus size={14}/> : <Plus size={14}/>}
        </span>
      </button>
      {connected && <button className="ghost-button connector-action" onClick={() => void disconnect()} disabled={busy}>Отключить</button>}
    </div>

    {connected && <div className="connector-actions-row">
      <button className="ghost-button" onClick={() => setOpen(value => !value)}>{open ? "Скрыть доступ" : "Заменить доступ"}</button>
      {onRefresh && <button className="ghost-button" onClick={onRefresh} disabled={busy || refreshing} title="Перечитать данные из кабинета">
        <RefreshCw size={11} className={refreshing ? "spin" : undefined}/>{refreshing ? "Обновляем…" : "Обновить данные"}
      </button>}
      <a className="ghost-button" href={provider.keyUrl} target="_blank" rel="noreferrer">{keyLabel} <ExternalLink size={11}/></a>
    </div>}

    {connected && writes && <label className="connector-write">
      <strong>Разрешить агенту изменять ресурсы</strong>
      <span className="switch"><input type="checkbox" checked={writes.allowed} disabled={busy || writes.busy} onChange={event => writes.onToggle(event.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></span>
    </label>}

    {error && <div className="connector-notice">{error}</div>}

    {open && <div className="connector-key">
      {/* Сначала то, что заполняют, — поля ключа. Разрешение спрашивается после: человек уже
          понимает, какой доступ даёт ключ, и не читает абзац перед вводом. */}
      {provider.fields.map(field => <label key={field.key}>
        <span><KeyRound size={12}/> {field.label}</span>
        {field.multiline
          ? <textarea rows={4} value={fields[field.key] ?? ""} placeholder={field.placeholder} onChange={event => setField(field.key, event.target.value)}/>
          : <input type={field.secret ? "password" : "text"} value={fields[field.key] ?? ""} placeholder={field.placeholder} autoComplete="off" spellCheck={false} onChange={event => setField(field.key, event.target.value)}/>}
      </label>)}

      {!connected && writes && <label className="connector-write">
        <strong>Разрешить агенту изменять ресурсы</strong>
        <span className="switch"><input type="checkbox" checked={writesDraft} disabled={busy} onChange={event => setWritesDraft(event.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></span>
      </label>}

      <div className="connector-actions-row">
        <button className="connector-action connector-connect" onClick={() => void save()} disabled={!ready || busy}>{busy ? "Проверяем доступ…" : "Сохранить"}</button>
        <a className="ghost-button" href={provider.keyUrl} target="_blank" rel="noreferrer">{keyLabel} <ExternalLink size={11}/></a>
      </div>

      <p className="connector-fineprint">{(fineprint ?? "Доступ проверяется до сохранения, шифруется на сервере и не возвращается в браузер. ")}<a href={provider.docsUrl} target="_blank" rel="noreferrer">Документация</a></p>
    </div>}
  </article>;
}
