import type { ReactNode } from "react";
import { Check, ChevronDown, Lock, Plus, RefreshCw } from "lucide-react";
import { BrandLogo, type BrandId } from "../../components/BrandLogo";

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
  /** Официальный логотип сервиса. Без него рисуется иконка в плитке того же размера. */
  logo?: BrandId;
  icon?: ReactNode;
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
  /** Карточка раскрывается по нажатию, как облака и сервисы с ключом. */
  expanded?: boolean;
  onToggle?: () => void;
  /** Тариф не даёт подключить сервис: карточка видна, но не реагирует на нажатия. */
  locked?: boolean;
  note?: ReactNode;
  children?: ReactNode;
};

/**
 * One service in the integrations list. Every connector renders through this card
 * so adding a service keeps the same shape: an icon, the service name and one
 * control that opens the provider's authorization page.
 *
 * Логотип, название и кружок действия — одна кнопка, а не строка с отдельной капсулой
 * «Подключить»: нажимать можно в любое место карточки. Кружок показывает, что произойдёт,
 * а подключённая карточка не ведёт по клику в отключение — это разрушительное действие
 * остаётся отдельной кнопкой, и заголовок становится обычной подписью.
 */
export function ConnectorCard({name,logo,icon,status,account,soon,busy,onConnect,onDisconnect,onRefresh,expanded,onToggle,locked,note,children}:ConnectorCardProps){
  // Плитка одна на все карточки: логотип бренда или иконка в том же прямоугольнике, иначе
  // квадратные знаки и длинные словесные логотипы делали строки разной высоты и ширины.
  const mark = logo ? <BrandLogo brand={logo}/> : <span className="brand-logo is-glyph">{icon}</span>;
  const state = locked ? <span className="connector-state locked"><Lock size={10}/>Доступно на платных тарифах</span>
    : soon ? <span className="connector-state">Интеграция в разработке</span>
    : status==="loading" ? <span className="connector-state">Проверяем подключение…</span>
    : status==="connected" ? <span className="connector-state ok"><span className="connector-dot"/>{account?"Подключено · @"+account:"Подключено"}</span>
    : status==="unavailable" ? <span className="connector-state">Не настроено на сервере</span>
    : null;
  const connectable = !soon && status !== "connected" && Boolean(onConnect);
  // Раскрытие важнее подключения: у GitLab и Yandex Cloud клик по строке сначала показывает
  // содержимое карточки, а не запускает OAuth или уводит в кабинет провайдера.
  const interactive = !locked && Boolean(onToggle || connectable);

  return <article className={"connector connector-"+status+(soon?" is-soon":"")+(locked?" is-locked":"")}>
    <div className="connector-head">
      {interactive
        ? <button type="button" className="connector-identity" onClick={onToggle ?? onConnect} disabled={busy} title={onToggle?(expanded?"Свернуть "+name:"Раскрыть "+name):"Подключить "+name} aria-label={onToggle?(expanded?"Свернуть "+name:"Раскрыть "+name):"Подключить "+name} aria-expanded={onToggle?Boolean(expanded):undefined}>
            {mark}
            <span className="connector-meta"><strong>{name}</strong>{state}</span>
            {/* Действие живёт в самом логотипе-карточке: отдельной кнопки «Подключить» больше
                нет, поэтому клик по всей строке и кружок справа — одно и то же действие. */}
            <span className={"connector-socket"+(expanded?" is-open":"")} aria-hidden="true">
              {onToggle?<ChevronDown size={14} className="connector-caret"/>:busy?<RefreshCw size={13} className="spin"/>:<Plus size={14}/>}
            </span>
          </button>
        : <div className="connector-identity connector-identity-static" aria-disabled={locked||undefined}>
            {mark}
            <span className="connector-meta"><strong>{name}</strong>{state}</span>
            {locked
              ? <span className="connector-socket is-locked" aria-hidden="true"><Lock size={13}/></span>
              : status==="connected"&&<span className="connector-socket is-on" aria-hidden="true"><Check size={13}/></span>}
          </div>}
      {soon
        ? <span className="soon-pill">скоро</span>
        : locked
          ? null
          : status==="connected"
            ? <div className="connector-actions">
                {onRefresh&&<button className="icon-button" onClick={onRefresh} disabled={busy} title="Обновить состояние"><RefreshCw size={13}/></button>}
                <button className="ghost-button connector-action" onClick={onDisconnect} disabled={busy}>Отключить</button>
              </div>
            : null}
    </div>
    {note}
    {!locked&&children}
  </article>;
}
