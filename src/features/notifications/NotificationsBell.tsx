import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, Bell, Check, Gift } from "lucide-react";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationsData,
} from "../../lib/notifications-api";

/**
 * Колокольчик уведомлений. Живёт в шапке рабочей области и в колонке главной, чтобы подарок
 * администратора или выданный тариф не меняли баланс молча: счётчик виден сразу, а список
 * объясняет, что произошло.
 *
 * Список обновляется при возврате на вкладку и раз в минуту: уведомление появляется из админки,
 * а не из этого окна, поэтому отдельного события здесь нет. Отметка «прочитано» сначала меняет
 * сервер, потом счётчик: иначе бейдж исчезал бы, не сохранившись после перезагрузки.
 */
export function NotificationsBell({ variant = "topbar" }: { variant?: "topbar" | "rail" | "tab" }) {
  const [data, setData] = useState<NotificationsData | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await listNotifications());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить уведомления");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Панель закрывается нажатием вне неё и по Escape — как меню аккаунта.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function readOne(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await markNotificationRead(id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отметить уведомление");
    } finally {
      setBusy(false);
    }
  }

  async function readAll() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await markAllNotificationsRead();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отметить уведомления");
    } finally {
      setBusy(false);
    }
  }

  const unread = data?.unread ?? 0;
  const notifications = data?.notifications ?? [];
  const triggerClass = variant === "topbar"
    ? "icon-button notifications-trigger"
    : variant === "rail"
      ? "rail-nav-item notifications-rail-trigger"
      : "home-tab notifications-tab-trigger";

  return <div className={"notifications notifications-" + variant} ref={rootRef}>
    <button
      className={triggerClass + (open ? " open active" : "")}
      onClick={() => setOpen(value => !value)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={"Уведомления" + (unread > 0 ? ", новых: " + unread : "")}
      title={unread > 0 ? "Уведомления: " + unread + " новых" : "Уведомления"}
    >
      <Bell size={15}/>
      {variant === "rail" && <span className="notifications-trigger-label">Уведомления</span>}
      {unread > 0 && <span className="notifications-badge" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
    </button>

    {open && <div className="notifications-panel" role="dialog" aria-label="Уведомления">
      <div className="notifications-head">
        <span>УВЕДОМЛЕНИЯ</span>
        {unread > 0 && <button className="notifications-read-all" onClick={() => void readAll()} disabled={busy}>Прочитать все</button>}
      </div>
      {error && <p className="notifications-error" role="alert">{error}</p>}
      {!data && !error && <p className="notifications-empty">Загружаем уведомления…</p>}
      {data && notifications.length === 0 && <p className="notifications-empty">
        Пока нет уведомлений. Здесь появятся подарки токенов и изменения тарифа.
      </p>}
      {notifications.length > 0 && <div className="notifications-list">
        {notifications.map(item => <div key={item.id} className={"notifications-item" + (item.readAt ? "" : " unread")}>
          <span className="notifications-icon" aria-hidden="true">
            {item.kind === "gift" ? <Gift size={13}/> : <BadgeCheck size={13}/>}
          </span>
          <div className="notifications-copy">
            <strong>{item.message}</strong>
            <small>{dateLabel(item.createdAt)}{item.readAt ? "" : " · новое"}</small>
          </div>
          {!item.readAt && <button
            className="notifications-read"
            onClick={() => void readOne(item.id)}
            disabled={busy}
            title="Отметить прочитанным"
            aria-label="Отметить прочитанным"
          ><Check size={12}/></button>}
        </div>)}
      </div>}
    </div>}
  </div>;
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
