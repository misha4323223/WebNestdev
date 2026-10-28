import { apiJson } from "./api";

/** Уведомление аккаунта: подарок токенов или выданный администратором тариф. */
export type AccountNotification = {
  id: string;
  kind: "gift" | "plan";
  message: string;
  tokens: number | null;
  plan: string | null;
  planUntil: string | null;
  createdAt: string;
  readAt: string | null;
};

export type NotificationsData = {
  notifications: AccountNotification[];
  unread: number;
};

export function listNotifications() {
  return apiJson<NotificationsData>("/api/me/notifications");
}

export function markNotificationRead(id: string) {
  return apiJson<{ ok: boolean }>("/api/me/notifications/" + encodeURIComponent(id) + "/read", {
    method: "POST",
  });
}

export function markAllNotificationsRead() {
  return apiJson<{ ok: boolean; read: number }>("/api/me/notifications/read-all", {
    method: "POST",
  });
}
