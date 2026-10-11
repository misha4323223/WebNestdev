import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Connection state of one service, as reported by the server.
 * - `loading`: the status request is still in flight;
 * - `connected`: an account is linked and the green indicator is shown;
 * - `disconnected`: nothing linked yet, the card offers the connect button;
 * - `unavailable`: the server has no OAuth credentials for this service yet.
 */
export type ConnectorStatus = "loading" | "connected" | "disconnected" | "unavailable";

export type ConnectorCardProps = {
  name: string;
  icon: ReactNode;
  status: ConnectorStatus;
  /** Account name shown next to the green indicator, for example a GitHub login. */
  account?: string | null;
  /** Reserved for connectors that are not implemented yet. */
  soon?: boolean;
  busy?: boolean;
  busyLabel?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onRefresh?: () => void;
  note?: ReactNode;
  children?: ReactNode;
};

/**
 * One service in the integrations list. Every connector renders through this card
 * so adding a service keeps the same shape: an icon, the service name and one
 * button that opens the provider's authorization page. The state only appears
 * when there is something to report — a linked account, a server that still
 * needs OAuth credentials, or work in progress.
 */
export function ConnectorCard({name,icon,status,account,soon,busy,busyLabel,onConnect,onDisconnect,onRefresh,note,children}:ConnectorCardProps){
  const state = soon ? <span className="connector-state">Интеграция в разработке</span>
    : status==="loading" ? <span className="connector-state">Проверяем подключение…</span>
    : status==="connected" ? <span className="connector-state ok"><span className="connector-dot"/>{account?"Подключено · @"+account:"Подключено"}</span>
    : status==="unavailable" ? <span className="connector-state">Не настроено на сервере</span>
    : null;

  return <article className={"connector connector-"+status+(soon?" is-soon":"")}>
    <div className="connector-head">
      <span className="connector-icon">{icon}</span>
      <div className="connector-meta"><strong>{name}</strong>{state}</div>
      {soon
        ? <span className="soon-pill">скоро</span>
        : status==="connected"
          ? <div className="connector-actions">
              {onRefresh&&<button className="icon-button" onClick={onRefresh} disabled={busy} title="Обновить состояние"><RefreshCw size={13}/></button>}
              <button className="ghost-button connector-action" onClick={onDisconnect} disabled={busy}>Отключить</button>
            </div>
          : <button className="connector-action connector-connect" onClick={onConnect} disabled={busy}>{busy?busyLabel??"Подключаем…":"Подключить"}</button>}
    </div>
    {note}
    {children}
  </article>;
}
