import { apiJson } from "./api";

export type HealthSnapshot = {
  build: string;
  sms?: { provider: string | null; label: string; testMode: boolean; credentialKind: "key" | "token" | null };
};

/**
 * Какая сборка работает на сервере и настроена ли отправка SMS. Экран входа показывает
 * первое: страница, взятая из кеша браузера, и старая версия в проде выглядят одинаково,
 * а по номеру сборки их различить можно за одну секунду.
 */
export const getHealth = () => apiJson<HealthSnapshot>("/api/health");
