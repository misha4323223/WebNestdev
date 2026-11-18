import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, Database, Lock, RefreshCw } from "lucide-react";
import { bytesLabel } from "../../lib/billing-api";
import {
  connectClientDatabase,
  disconnectClientDatabase,
  getClientDatabase,
  type ClientDatabaseStatus,
} from "../../lib/client-database-api";

/**
 * Карточка встроенной базы в настройках аккаунта.
 *
 * База принадлежит аккаунту, а строка подключения живёт в секретах конкретного проекта.
 * Поэтому настройка всегда показывает текущий проект и не притворяется, что база уже
 * существует: до первого подключения это только доступная возможность.
 */
export function ClientDatabaseCard({
  projectId,
  projectName,
  onUpgrade,
}: {
  projectId?: string;
  projectName?: string;
  onUpgrade: () => void;
}) {
  const [status, setStatus] = useState<ClientDatabaseStatus | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setStatus(await getClientDatabase(projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось получить состояние базы");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function connect() {
    if (!projectId || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await connectClientDatabase(projectId);
      setNotice("База подключена к проекту «" + (projectName || "текущий") + "». Агент увидит DATABASE_URL в секретах.");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подключить базу");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!projectId || busy) return;
    if (!window.confirm("Отключить встроенную базу от проекта «" + (projectName || "текущий") + "»? Схема и данные аккаунта сохранятся.")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await disconnectClientDatabase(projectId);
      setNotice("База отключена от этого проекта. Данные аккаунта остались на месте.");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отключить базу");
    } finally {
      setBusy(false);
    }
  }

  const active = status?.available === true ? status : null;
  const included = active !== null && active.limitBytes > 0;
  const provisioned = active?.provisioned === true;
  const usedPercent = active && active.limitBytes > 0
    ? Math.min(100, Math.round(active.usedBytes / active.limitBytes * 100))
    : 0;
  const state = !projectId
    ? "выберите проект"
    : loading
      ? "проверяем"
      : !active
        ? "недоступна"
        : !included
          ? "нужен «Плюс»"
          : provisioned
            ? "подключена"
            : "не подключена";

  return <div className={"client-db-card" + (provisioned ? " is-connected" : "") + (!included && active ? " is-locked" : "")}>
    <div className="client-db-head">
      <span className="client-db-mark"><Database size={19}/></span>
      <div className="client-db-heading">
        <strong>Встроенная база NestDev</strong>
        <small>PostgreSQL для данных приложения · без внешнего провайдера</small>
      </div>
      <span className={"client-db-state" + (provisioned ? " ok" : "")}>{state}</span>
    </div>

    {!projectId && <p className="account-muted client-db-empty">Откройте проект и вернитесь в настройки: строка подключения создаётся для конкретного проекта.</p>}
    {projectId && loading && <p className="account-muted client-db-empty">Проверяем базу аккаунта…</p>}
    {error && <div className="settings-error">{error}</div>}
    {projectId && !loading && status?.available === false && <div className="client-db-notice">
      <Lock size={14}/>
      <span>На этой установке встроенная база пока не включена администратором. {status.reason}</span>
    </div>}

    {projectId && !loading && active && !included && <>
      <div className="client-db-notice">
        <Lock size={14}/>
        <span>Встроенная база входит в «Плюс» и «Премиум». На «Старте» можно подключить свою PostgreSQL через интеграции.</span>
      </div>
      <div className="client-db-actions">
        <button type="button" className="send-button" onClick={onUpgrade}>Посмотреть тарифы <ArrowRight size={13}/></button>
      </div>
    </>}

    {projectId && !loading && active && included && <>
      <div className="client-db-status">
        <div><span>Проект</span><strong>{projectName || "Текущий проект"}</strong></div>
        <div><span>Соединение</span><strong>PostgreSQL · только для проекта</strong></div>
        <div><span>Занято</span><strong>{bytesLabel(active.usedBytes)} из {bytesLabel(active.limitBytes)}</strong></div>
        <div className="client-db-meter" aria-hidden="true"><span style={{ width: `${Math.max(2, usedPercent)}%` }}/></div>
        <small className="client-db-role">роль {active.role}{active.readOnly ? " · только чтение" : ""}</small>
      </div>
      {!active.reachable && <div className="client-db-notice"><RefreshCw size={14}/><span>База не отвечает: {active.error || "проверьте подключение и повторите."}</span></div>}
      {active.readOnly && <div className="client-db-notice"><Lock size={14}/><span>Сейчас база работает только на чтение: закончилась квота или тариф не включает запись. Данные не удалены.</span></div>}
      <div className="client-db-actions">
        {!provisioned
          ? <button type="button" className="send-button" disabled={busy || !active.reachable} onClick={() => void connect()}>
              {busy ? "Создаём…" : "Создать и подключить"}
            </button>
          : <span className="client-db-connected"><Check size={13}/> DATABASE_URL уже в секретах проекта</span>}
        {provisioned && <button type="button" className="ghost-button" disabled={busy} onClick={() => void disconnect()}>Отключить от проекта</button>}
        <button type="button" className="ghost-button client-db-refresh" disabled={busy || loading} onClick={() => void reload()} title="Обновить состояние базы" aria-label="Обновить состояние базы"><RefreshCw size={13}/></button>
      </div>
      {!provisioned && <p className="account-muted client-db-footnote">Создадим схему на аккаунт и положим строку подключения в секреты проекта. Пароль не показывается ни в браузере, ни агенту.</p>}
      {provisioned && <p className="account-muted client-db-footnote">Одна встроенная база на аккаунт. Повторное подключение к другому проекту обновит пароль — не подключайте два проекта одновременно без необходимости.</p>}
    </>}

    {notice && <div className="settings-status client-db-notice"><Check size={13}/><span>{notice}</span></div>}
  </div>;
}
