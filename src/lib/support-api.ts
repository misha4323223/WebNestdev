import { apiJson } from "./api";

export type SupportCategory = "bug" | "idea";

export type SupportTicketInput = {
  category: SupportCategory;
  /** 1 — мелочь, 10 — блокирует работу. */
  severity: number;
  description: string;
  steps?: string;
  context?: string;
  page?: string;
  projectId?: string;
  /** Почта для ответа: подставляется из профиля, а без неё человек вводит её сам. */
  contactEmail?: string;
  /** data URL картинки: сервер проверяет сигнатуру и размер. */
  screenshot: string;
};

/**
 * `notified` — письмо ушло на почту поддержки, `mailConfigured` — почта на сервере вообще настроена.
 * Окно по этим двум полям говорит правду: обещать «ответим на почту», когда письмо не ушло, нельзя.
 */
export type SupportTicketResult = {
  ok: true;
  id: string;
  createdAt: string;
  notified: boolean;
  mailConfigured: boolean;
};

export const sendSupportTicket = (input: SupportTicketInput) =>
  apiJson<SupportTicketResult>("/api/support", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
