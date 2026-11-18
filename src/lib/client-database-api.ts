import { apiJson } from "./api";

/**
 * Состояние встроенной базы проекта. Строку подключения сервер не возвращает:
 * в браузер и в ответы агента попадает только маска без пароля.
 */
export type ClientDatabaseStatus =
  | { available: false; reason: string }
  | {
      available: true;
      reachable: boolean;
      provisioned: boolean;
      role: string;
      maskedUrl: string;
      usedBytes: number;
      limitBytes: number;
      readOnly: boolean;
      error?: string;
    };

export type ClientDatabaseConnectResult = {
  ok: true;
  role: string;
  schema: string;
  maskedUrl: string;
  file: string;
  limitBytes: number;
  note: string;
};

const base = (projectId: string) => "/api/projects/" + encodeURIComponent(projectId) + "/client-database";

/** Сводка для личного кабинета: занятое место по базе аккаунта, без привязки к проекту. */
export const getAccountClientDatabase = () => apiJson<ClientDatabaseStatus>("/api/account/client-database");

export const getClientDatabase = (projectId: string) => apiJson<ClientDatabaseStatus>(base(projectId));

/** Создаёт схему аккаунта (если её нет), обновляет пароль и кладёт DATABASE_URL в секреты проекта. */
export const connectClientDatabase = (projectId: string) =>
  apiJson<ClientDatabaseConnectResult>(base(projectId), { method: "POST" });

/** Убирает DATABASE_URL только из этого проекта: схема и данные остаются у аккаунта. */
export const disconnectClientDatabase = (projectId: string) =>
  apiJson<{ ok: true; removed: boolean; note: string }>(base(projectId), { method: "DELETE" });
